import { getDb, isVecEnabled } from '../shared/db.js';
import { createLogger } from '../shared/logger.js';
import { boostFactHeat, setDb as storeSetDb } from '../worker/store.js';

const log = createLogger('memory-search');

let _storeInitialized = false;
function ensureStoreDb() {
  if (!_storeInitialized) {
    try { storeSetDb(getDb()); _storeInitialized = true; } catch { /* store may already have db */ }
  }
}

export async function memorySearch(params) {
  const db = getDb();
  const { query, project_id, top_k = 10, fact_types, time_from, time_to, status = 'active', scope = 'all' } = params;
  const limit = Math.min(top_k, 50);

  if (isVecEnabled()) {
    try {
      const result = await vectorSearch(db, { query, project_id, limit, fact_types, time_from, time_to, status, scope });
      if (result !== 'No matching facts found.') return result;
      log.debug('vector search returned empty, falling back to text');
    } catch (err) {
      log.warn({ err: err.message, stack: err.stack }, 'vector search failed, falling back to text');
    }
  }

  return textSearch(db, { query, project_id, limit, fact_types, time_from, time_to, status, scope });
}

async function vectorSearch(db, params) {
  const { query, project_id, limit, fact_types, time_from, time_to, status, scope } = params;
  const { initEmbedder, embedTexts } = await import('../worker/embedder.js');
  const { loadConfig } = await import('../shared/config.js');
  await initEmbedder(loadConfig().worker.embedding);
  const embeddings = await embedTexts([query]);
  const queryEmbedding = new Float32Array(embeddings[0]);
  const embBuf = Buffer.from(queryEmbedding.buffer);

  // vec0 doesn't support OR conditions — run separate queries per scope, then merge
  const queries = [];

  if (scope === 'project' || scope === 'all') {
    queries.push(db.prepare(`
      SELECT fe.fact_id, fe.distance, f.predicate, f.object_text, f.fact_type, f.confidence, f.scope, f.created_at, e.canonical_name as subject
      FROM (
        SELECT fact_id, distance FROM fact_embeddings
        WHERE project_id = ? AND scope = 'project' AND status = ? AND embedding MATCH ? AND k = ?
      ) fe
      JOIN facts f ON f.id = fe.fact_id
      LEFT JOIN entities e ON f.subject_entity_id = e.id
    `).all(project_id, status, embBuf, limit));
  }

  if (scope === 'global' || scope === 'all') {
    queries.push(db.prepare(`
      SELECT fe.fact_id, fe.distance, f.predicate, f.object_text, f.fact_type, f.confidence, f.scope, f.created_at, e.canonical_name as subject
      FROM (
        SELECT fact_id, distance FROM fact_embeddings
        WHERE scope = 'global' AND status = ? AND embedding MATCH ? AND k = ?
      ) fe
      JOIN facts f ON f.id = fe.fact_id
      LEFT JOIN entities e ON f.subject_entity_id = e.id
    `).all(status, embBuf, limit));
  }

  // Merge, deduplicate by fact_id, sort by distance, take top limit
  const seen = new Set();
  let rows = [];
  for (const batch of queries) {
    for (const row of batch) {
      if (!seen.has(row.fact_id)) {
        seen.add(row.fact_id);
        rows.push(row);
      }
    }
  }
  rows.sort((a, b) => a.distance - b.distance);
  rows = rows.slice(0, limit);

  if (fact_types?.length) rows = rows.filter(r => fact_types.includes(r.fact_type));
  if (time_from) rows = rows.filter(r => r.created_at >= time_from);
  if (time_to) rows = rows.filter(r => r.created_at <= time_to);

  if (rows.length > 0) {
    try {
      ensureStoreDb();
      boostFactHeat(rows.map(r => r.fact_id));
    } catch (err) { log.debug({ err: err.message }, 'boost failed'); }
  }

  return formatResults(rows);
}

function textSearch(db, params) {
  const { query, project_id, limit, fact_types, time_from, time_to, status, scope } = params;

  let sql = `SELECT f.id as fact_id, f.predicate, f.object_text, f.fact_type, f.confidence, f.scope, f.created_at, e.canonical_name as subject
    FROM facts f LEFT JOIN entities e ON f.subject_entity_id = e.id
    WHERE f.status = ?`;
  const p = [status];

  // Scope filter
  if (scope === 'project') {
    sql += ` AND f.project_id = ? AND f.scope = 'project'`;
    p.push(project_id);
  } else if (scope === 'global') {
    sql += ` AND f.scope = 'global'`;
  } else {
    // scope='all' (default): project-scoped for current project + all global
    sql += ` AND ((f.project_id = ? AND f.scope = 'project') OR f.scope = 'global')`;
    p.push(project_id);
  }

  // Segment query into keywords; Intl.Segmenter handles CJK word boundaries natively (Node 16+, zero deps)
  const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f]/;
  const STOP_WORDS = new Set(['的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '這', '中', '大', '為', '上', '個', '與', '也', '到', '說', '等', '她', '你', '他', '它']);
  let keywords = query.split(/\s+/).filter(Boolean);
  if (keywords.length === 1 && CJK_RE.test(keywords[0])) {
    const segmenter = new Intl.Segmenter('zh-TW', { granularity: 'word' });
    keywords = [...segmenter.segment(keywords[0])]
      .filter(s => s.isWordLike && !STOP_WORDS.has(s.segment))
      .map(s => s.segment);
    if (keywords.length === 0) keywords = [query]; // fallback to original
  }
  if (keywords.length > 0) {
    const conds = keywords.map(() => `(e.canonical_name LIKE ? OR f.predicate LIKE ? OR f.object_text LIKE ?)`);
    sql += ` AND (${conds.join(' OR ')})`;
    for (const kw of keywords) { const l = `%${kw}%`; p.push(l, l, l); }
  }
  if (fact_types?.length) { sql += ` AND f.fact_type IN (${fact_types.map(() => '?').join(',')})`; p.push(...fact_types); }
  if (time_from) { sql += ` AND f.created_at >= ?`; p.push(time_from); }
  if (time_to) { sql += ` AND f.created_at <= ?`; p.push(time_to); }
  sql += ` ORDER BY f.heat DESC, f.created_at DESC LIMIT ?`;
  p.push(limit);

  const results = db.prepare(sql).all(...p);
  if (results.length > 0) {
    try {
      ensureStoreDb();
      boostFactHeat(results.map(r => r.fact_id));
    } catch (err) { log.debug({ err: err.message }, 'boost failed'); }
  }

  return formatResults(results);
}

function formatResults(rows) {
  if (rows.length === 0) return 'No matching facts found.';
  let md = `| Subject | Predicate | Object | Type | Scope | Conf | Date |\n|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    const s = trunc(r.subject || '?', 30), p = trunc(r.predicate, 25), o = trunc(r.object_text, 50);
    const sc = r.scope || 'project';
    md += `| ${s} | ${p} | ${o} | ${r.fact_type} | ${sc} | ${r.confidence} | ${(r.created_at || '').substring(0, 10)} |\n`;
  }
  return md + `\n_${rows.length} results_`;
}

function trunc(str, n) {
  if (!str) return '';
  const s = str.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return s.length > n ? s.substring(0, n - 1) + '...' : s;
}
