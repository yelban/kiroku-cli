import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { planRepoGrounding, isRepoRelativePath } from './grounding-planner.js';
import { applyRepoGroundingPlan } from './store.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('repo-grounding');
const GIT_TIMEOUT_MS = 15_000;

// Read-only git adapter. Any failure (missing repo, stale ref, permission,
// timeout) degrades to "skip this project this round" — never to disposal.
export function collectRepoSnapshot({ rootPath, sinceCommit, candidatePaths = [] }) {
  const git = (args) => execFileSync(
    'git',
    ['-C', rootPath, '--no-optional-locks', ...args],
    { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  try {
    const headCommit = git(['rev-parse', 'HEAD']).trim();
    const tracked = new Set(git(['ls-files']).split('\n').filter(Boolean));

    let renames = [];
    let refReset = false;
    if (sinceCommit && sinceCommit !== headCommit) {
      try {
        renames = parseRenames(git(['diff', '--find-renames', '--name-status', sinceCommit, 'HEAD']));
      } catch {
        // Stale base ref (gc, force push, history rewrite): skip renames this
        // round and let the ref reset to HEAD; the missing flow backstops.
        refReset = true;
      }
    }

    const missingPaths = candidatePaths.filter(
      path => !tracked.has(path) && !existsSync(join(rootPath, path)),
    );

    return { ok: true, headCommit, renames, missingPaths, refReset };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function parseRenames(output) {
  const renames = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('R')) continue;
    const parts = line.split('\t');
    if (parts.length >= 3 && parts[1] && parts[2]) {
      renames.push({ from: parts[1], to: parts[2] });
    }
  }
  return renames;
}

export async function runRepoGroundingSweep(db, config, { now = new Date().toISOString(), collectSnapshot = collectRepoSnapshot } = {}) {
  const grounding = config.worker?.repoGrounding;
  if (!grounding?.enabled) return;
  const confirmMs = (grounding.confirmHours ?? 6) * 3600_000;

  const projects = db.prepare(
    'SELECT id, root_path AS rootPath, last_swept_commit AS lastSweptCommit FROM projects WHERE root_path IS NOT NULL',
  ).all();

  for (const project of projects) {
    try {
      const pathFacts = selectPathFacts(db, project.id);
      const candidatePaths = [...new Set(pathFacts.map(fact => fact.path))];
      const snapshot = collectSnapshot({
        rootPath: project.rootPath,
        sinceCommit: project.lastSweptCommit,
        candidatePaths,
      });
      if (!snapshot.ok) {
        log.debug({ projectId: project.id, error: snapshot.error }, 'repo unavailable, project skipped');
        continue;
      }

      const plan = planRepoGrounding({ pathFacts, snapshot, now, confirmMs });
      applyRepoGroundingPlan({
        projectId: project.id,
        plan,
        now,
        floorByType: config.worker?.decay?.floorByType,
      });

      db.prepare('UPDATE projects SET last_swept_commit = ?, updated_at = ? WHERE id = ?')
        .run(snapshot.headCommit ?? null, now, project.id);

      if (plan.moves.length || plan.markMissing.length || plan.clearMissing.length || plan.archive.length) {
        log.info({
          projectId: project.id,
          moves: plan.moves.length,
          marked: plan.markMissing.length,
          cleared: plan.clearMissing.length,
          archived: plan.archive.length,
        }, 'repo grounding applied');
      }
    } catch (err) {
      log.warn({ projectId: project.id, err: err.message }, 'repo grounding failed for project');
    }
  }
}

function selectPathFacts(db, projectId) {
  return db.prepare(`
    SELECT f.id AS factId, f.missing_since AS missingSince, e.canonical_name AS path
    FROM facts f
    JOIN entities e ON f.subject_entity_id = e.id
    WHERE f.project_id = ? AND f.scope = 'project' AND f.status = 'active' AND e.entity_type = 'file'
  `).all(projectId).filter(row => isRepoRelativePath(row.path));
}
