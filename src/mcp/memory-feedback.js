import { getDb } from '../shared/db.js';
import { loadConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { writeAudit } from '../shared/audit.js';

const log = createLogger('memory-feedback');

// Above this many matches the verdict is refused: a broad LIKE hitting half
// the project must not demote it wholesale.
const MAX_MATCHES = 5;

export function memoryFeedback(params) {
  const db = getDb();
  const verdict = params.verdict;
  if (verdict !== 'stale' && verdict !== 'confirmed') {
    throw new Error(`verdict must be 'stale' or 'confirmed', got: ${verdict}`);
  }
  if (!params.fact_id && !params.subject && !params.predicate && !params.object) {
    throw new Error('Provide fact_id or at least one of subject/predicate/object.');
  }

  const matches = selectFeedbackTargets(db, params);
  if (matches.length === 0) return 'No matching active facts.';
  if (matches.length > MAX_MATCHES) {
    return `Matched ${matches.length} facts (limit ${MAX_MATCHES}) — refusing to apply feedback this broadly. Narrow it with a more specific subject/predicate/object, or a fact_id.`;
  }

  const now = new Date().toISOString();
  const floorByType = resolveFloorByType();
  const lines = [];

  for (const fact of matches) {
    if (verdict === 'stale') {
      const floor = floorByType[fact.fact_type] ?? 0;
      const heatAfter = Math.max(floor, fact.heat * 0.5);
      const baseHeatAfter = Math.max(floor, fact.base_heat * 0.5);
      db.prepare('UPDATE facts SET heat = ?, base_heat = ?, updated_at = ? WHERE id = ?')
        .run(heatAfter, baseHeatAfter, now, fact.id);
      lines.push(`- ${describeFact(fact)} (heat ${round2(fact.heat)} → ${round2(heatAfter)})`);
    } else {
      db.prepare('UPDATE facts SET last_accessed_at = ?, missing_since = NULL, updated_at = ? WHERE id = ?')
        .run(now, now, fact.id);
      lines.push(`- ${describeFact(fact)} (last confirmed refreshed)`);
    }
    writeAudit(db, {
      projectId: params.project_id,
      action: 'feedback',
      targetType: 'fact',
      targetId: fact.id,
      detail: {
        verdict,
        reason: params.reason || null,
        query: {
          fact_id: params.fact_id || null,
          subject: params.subject || null,
          predicate: params.predicate || null,
          object: params.object || null,
        },
      },
    });
  }

  log.info({ verdict, count: matches.length }, 'memory feedback applied');
  const header = verdict === 'stale'
    ? `Marked ${matches.length} fact(s) stale (demoted, still recoverable):`
    : `Confirmed ${matches.length} fact(s) as still valid:`;
  return `${header}\n${lines.join('\n')}`;
}

function selectFeedbackTargets(db, params) {
  if (params.fact_id) {
    const row = db.prepare(`
      SELECT f.id, f.fact_type, f.heat, f.base_heat, f.predicate, f.object_text, e.canonical_name AS subject
      FROM facts f LEFT JOIN entities e ON f.subject_entity_id = e.id
      WHERE f.id = ? AND f.status = 'active'
    `).get(params.fact_id);
    return row ? [row] : [];
  }

  let sql = `
    SELECT f.id, f.fact_type, f.heat, f.base_heat, f.predicate, f.object_text, e.canonical_name AS subject
    FROM facts f LEFT JOIN entities e ON f.subject_entity_id = e.id
    WHERE (f.project_id = ? OR f.scope = 'global') AND f.status = 'active'`;
  const args = [params.project_id];
  if (params.subject) { sql += ' AND e.canonical_name LIKE ?'; args.push(`%${params.subject}%`); }
  if (params.predicate) { sql += ' AND f.predicate LIKE ?'; args.push(`%${params.predicate}%`); }
  if (params.object) { sql += ' AND f.object_text LIKE ?'; args.push(`%${params.object}%`); }
  return db.prepare(sql).all(...args);
}

function resolveFloorByType() {
  try {
    return loadConfig().worker?.decay?.floorByType || {};
  } catch {
    return {};
  }
}

function describeFact(fact) {
  return `${fact.subject || '?'} ${fact.predicate} ${fact.object_text}`;
}

function round2(value) {
  return Number(Number(value).toFixed(2));
}
