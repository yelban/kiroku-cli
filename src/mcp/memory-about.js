import { getDb } from '../shared/db.js';
import { createLogger } from '../shared/logger.js';
import { redactSecrets } from '../shared/redact.js';

const log = createLogger('memory-about');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;
const DEFAULT_FACT_CAP = 200;
const FACT_TYPE_ORDER = ['preference', 'semantic', 'task', 'state', 'episodic'];

export function memoryAbout(params) {
  const db = getDb();
  const subject = params.subject;
  const projectId = params.project_id;
  const cap = params.cap || DEFAULT_FACT_CAP;

  const resolution = resolveSubjectEntity(db, subject);
  if (!resolution) {
    return `No active facts found for "${subject}".`;
  }

  const rows = selectRowsForEntity(db, { entityId: resolution.entity.id, projectId, cap });
  if (rows.length === 0) {
    return `No active facts found for "${subject}".`;
  }

  log.info({ subject, resolvedVia: resolution.via, count: rows.length }, 'memory_about');
  return renderMemoryAboutRows(rows, { subject, resolution, cap });
}

export function selectMemoryAboutRows(db, { subject, projectId, cap = DEFAULT_FACT_CAP }) {
  const resolution = resolveSubjectEntity(db, subject);
  if (!resolution) return [];
  return selectRowsForEntity(db, { entityId: resolution.entity.id, projectId, cap });
}

// Resolution order: exact canonical name, then normalized name, then alias
// membership — but an entity that has ceased to hold active facts (e.g. the
// old name after a move) yields to the entity that now carries the name as an
// alias, so queries by a retired name land on the current entity.
function resolveSubjectEntity(db, subject) {
  if (!subject) return null;

  const candidates = [];
  const exact = db.prepare('SELECT id, canonical_name, aliases_json FROM entities WHERE canonical_name = ?').get(subject);
  if (exact) candidates.push({ entity: exact, via: 'canonical' });

  const normalized = normalizeName(subject);
  const byNormalized = db.prepare('SELECT id, canonical_name, aliases_json FROM entities WHERE normalized_name = ?').get(normalized);
  if (byNormalized && byNormalized.id !== exact?.id) {
    candidates.push({ entity: byNormalized, via: 'normalized name' });
  }

  const aliasRows = db.prepare('SELECT id, canonical_name, aliases_json FROM entities WHERE aliases_json LIKE ?')
    .all(`%${JSON.stringify(subject)}%`);
  for (const row of aliasRows) {
    if (candidates.some(c => c.entity.id === row.id)) continue;
    try {
      const aliases = JSON.parse(row.aliases_json || '[]');
      if (Array.isArray(aliases) && aliases.includes(subject)) {
        candidates.push({ entity: row, via: `alias of ${row.canonical_name}` });
      }
    } catch { /* unreadable aliases_json */ }
  }

  if (candidates.length === 0) return null;

  const countStmt = db.prepare("SELECT COUNT(*) AS c FROM facts WHERE subject_entity_id = ? AND status = 'active'");
  for (const candidate of candidates) {
    if (countStmt.get(candidate.entity.id).c > 0) return candidate;
  }
  return candidates[0];
}

function selectRowsForEntity(db, { entityId, projectId, cap }) {
  return db.prepare(`
    SELECT f.id AS fact_id, f.project_id, f.predicate, f.object_text, f.object_detail,
           f.fact_type, f.confidence, f.scope, f.status, f.created_at, f.heat,
           e.canonical_name AS subject
    FROM facts f
    LEFT JOIN entities e ON f.subject_entity_id = e.id
    WHERE f.subject_entity_id = ?
      AND f.status = 'active'
      AND ((f.project_id = ? AND f.scope = 'project') OR f.scope = 'global')
    ORDER BY
      CASE f.fact_type
        WHEN 'preference' THEN 0
        WHEN 'semantic'   THEN 1
        WHEN 'task'       THEN 2
        WHEN 'state'      THEN 3
        WHEN 'episodic'   THEN 4
        ELSE 5
      END,
      f.created_at DESC
    LIMIT ?
  `).all(entityId, projectId, cap);
}

export function renderMemoryAboutRows(rows, { subject, resolution, cap }) {
  const entityName = resolution.entity.canonical_name;
  const viaNote = resolution.via === 'canonical' ? '' : ` (resolved via ${resolution.via})`;
  const capNote = rows.length >= cap ? ` — truncated at ${cap}` : '';
  const lines = [`# Memory: ${entityName}${viaNote} — ${rows.length} active facts${capNote}`];

  for (const factType of [...FACT_TYPE_ORDER, 'other']) {
    const group = rows.filter(row => (
      factType === 'other' ? !FACT_TYPE_ORDER.includes(row.fact_type) : row.fact_type === factType
    ));
    if (group.length === 0) continue;
    lines.push('', `## ${factType}`);
    for (const row of group) {
      const detail = row.object_detail ? ` — ${row.object_detail}` : '';
      const scope = row.scope === 'global' ? ' [global]' : '';
      lines.push(redactSecrets(`- ${row.predicate} ${row.object_text}${detail}${scope}${formatAgeMarker(row.created_at)}`));
    }
  }

  if (subject !== entityName) {
    lines.push('', `_Queried as "${subject}"._`);
  }
  return lines.join('\n');
}

function formatAgeMarker(createdAt) {
  if (!createdAt) return '';
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return '';

  const ageDays = Math.max(0, (Date.now() - createdMs) / MS_PER_DAY);
  if (ageDays < 14) return ` (${roundedAge(ageDays)}d)`;
  if (ageDays < 70) return ` (${roundedAge(ageDays / DAYS_PER_WEEK)}w)`;
  return ` (${roundedAge(ageDays / DAYS_PER_MONTH)}mo)`;
}

function roundedAge(value) {
  return Math.max(1, Math.round(value));
}

function normalizeName(name) {
  return name.toLowerCase().replace(/[-_ ]/g, '');
}
