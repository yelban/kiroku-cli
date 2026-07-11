// Pure planner for the repo-grounding sweep: no DB, no git, no clock reads —
// everything arrives as input so the exam can drive it with synthetic
// snapshots (same seam pattern as move-planner).

export function planRepoGrounding({ pathFacts = [], snapshot = {}, now, confirmMs = 6 * 3600_000 }) {
  const renames = Array.isArray(snapshot.renames) ? snapshot.renames : [];
  const missingSet = new Set(Array.isArray(snapshot.missingPaths) ? snapshot.missingPaths : []);
  const renameByFrom = new Map();
  for (const rename of renames) {
    if (rename?.from && rename?.to && !renameByFrom.has(rename.from)) {
      renameByFrom.set(rename.from, rename.to);
    }
  }

  const plan = { moves: [], markMissing: [], clearMissing: [], archive: [] };
  const nowMs = Date.parse(now);
  const movedFrom = new Set();

  for (const fact of pathFacts) {
    const toPath = renameByFrom.get(fact.path);
    if (toPath) {
      // Rename wins over the missing flow: the move pass retires this fact
      // and carries the name into the target entity's aliases. One move per
      // from-path — the pass supersedes every active fact on that entity, so
      // re-detecting the same rename next sweep finds no active facts and
      // plans nothing (natural idempotence).
      if (!movedFrom.has(fact.path)) {
        movedFrom.add(fact.path);
        plan.moves.push({ fromPath: fact.path, toPath });
      }
      continue;
    }
    if (missingSet.has(fact.path)) {
      if (!fact.missingSince) {
        plan.markMissing.push({ factId: fact.factId, path: fact.path });
      } else if (nowMs - Date.parse(fact.missingSince) >= confirmMs) {
        plan.archive.push({ factId: fact.factId, path: fact.path });
      }
      // Between mark and confirm: wait for the next sweep.
      continue;
    }
    if (fact.missingSince) {
      plan.clearMissing.push({ factId: fact.factId, path: fact.path });
    }
  }

  return plan;
}

// A path fact is only groundable when its subject looks like a repo-relative
// path: absolute paths, home paths, and URLs point outside the repository.
export function isRepoRelativePath(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.startsWith('/') || name.startsWith('~') || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(name)) return false;
  return name.includes('/') || /\.[a-z0-9]{1,8}$/i.test(name);
}
