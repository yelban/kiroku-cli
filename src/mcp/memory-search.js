import { getDb, isVecEnabled } from '../shared/db.js';
import { loadConfig } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { boostFactHeat, setDb as storeSetDb } from '../worker/store.js';
import { isDiverse } from './project-brief.js';
import { redactSecrets } from '../shared/redact.js';

const log = createLogger('memory-search');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TEXT_SEARCH_SIMILARITY = 1;
const DEFAULT_SEARCH_RANKING = Object.freeze({
  simWeight: 0.65,
  heatWeight: 0.15,
  recencyWeight: 0.20,
  halfLifeDays: 30,
});

let _storeInitialized = false;
function ensureStoreDb() {
  if (!_storeInitialized) {
    try { storeSetDb(getDb()); _storeInitialized = true; } catch { /* store may already have db */ }
  }
}

export async function memorySearch(params) {
  const rows = await selectMemorySearchRows(params);
  boostSearchRows(rows);
  return renderMemorySearchRows(rows, params?.status ?? 'active');
}

export async function selectMemorySearchRows(params) {
  const db = getDb();
  const searchParams = normalizeSearchParams(params);

  if (isVecEnabled()) {
    try {
      const rows = await vectorSearchRows(db, searchParams);
      if (rows.length > 0) return rows;
      log.debug('vector search returned empty, falling back to text');
    } catch (err) {
      log.warn({ err: err.message, stack: err.stack }, 'vector search failed, falling back to text');
    }
  }

  return textSearchRows(db, searchParams);
}

function normalizeSearchParams(params) {
  const { query, project_id, top_k = 10, fact_types, time_from, time_to, status = 'active', scope = 'all' } = params;
  return { query, project_id, limit: Math.min(top_k, 50), fact_types, time_from, time_to, status, scope };
}

async function vectorSearchRows(db, params) {
  const { query, project_id, limit, fact_types, time_from, time_to, status, scope } = params;
  const { initEmbedder, embedTexts } = await import('../worker/embedder.js');
  const config = loadConfig();
  await initEmbedder(config.worker.embedding);
  const embeddings = await embedTexts([query]);
  const queryEmbedding = new Float32Array(embeddings[0]);
  const embBuf = Buffer.from(queryEmbedding.buffer);
  const candidateLimit = limit * 3;

  // vec0 doesn't support OR conditions — run separate queries per scope, then merge
  const queries = [];

  if (scope === 'project' || scope === 'all') {
    queries.push(db.prepare(`
      SELECT fe.fact_id, fe.distance, f.project_id, f.predicate, f.object_text, f.object_detail, f.fact_type, f.confidence, f.scope, f.created_at, f.heat, f.access_count, e.canonical_name as subject
      FROM (
        SELECT fact_id, distance FROM fact_embeddings
        WHERE project_id = ? AND scope = 'project' AND status = ? AND embedding MATCH ? AND k = ?
      ) fe
      JOIN facts f ON f.id = fe.fact_id
      LEFT JOIN entities e ON f.subject_entity_id = e.id
    `).all(project_id, status, embBuf, candidateLimit));
  }

  if (scope === 'global' || scope === 'all') {
    queries.push(db.prepare(`
      SELECT fe.fact_id, fe.distance, f.project_id, f.predicate, f.object_text, f.object_detail, f.fact_type, f.confidence, f.scope, f.created_at, f.heat, f.access_count, e.canonical_name as subject
      FROM (
        SELECT fact_id, distance FROM fact_embeddings
        WHERE scope = 'global' AND status = ? AND embedding MATCH ? AND k = ?
      ) fe
      JOIN facts f ON f.id = fe.fact_id
      LEFT JOIN entities e ON f.subject_entity_id = e.id
    `).all(status, embBuf, candidateLimit));
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
  rows = rows.slice(0, candidateLimit); // over-fetch for diversity filtering

  if (fact_types?.length) rows = rows.filter(r => fact_types.includes(r.fact_type));
  if (time_from) rows = rows.filter(r => r.created_at >= time_from);
  if (time_to) rows = rows.filter(r => r.created_at <= time_to);

  rows = rankSearchRows(rows, getSearchRankingConfig(config));
  rows = diversityFilter(rows, limit);

  return rows;
}

function textSearchRows(db, params) {
  const { query, project_id, limit, fact_types, time_from, time_to, status, scope } = params;

  let sql = `SELECT f.id as fact_id, f.project_id, f.predicate, f.object_text, f.object_detail, f.fact_type, f.confidence, f.scope, f.created_at, f.heat, f.access_count, e.canonical_name as subject
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
  p.push(limit * 3); // over-fetch for diversity filtering

  let results = db.prepare(sql).all(...p);
  results = rankSearchRows(results, getSearchRankingConfig());
  results = diversityFilter(results, limit);
  return results;
}

function getSearchRankingConfig(config = loadConfig()) {
  const ranking = config?.mcp?.search?.ranking ?? {};
  return {
    simWeight: finiteNumberOrDefault(ranking.simWeight, DEFAULT_SEARCH_RANKING.simWeight),
    heatWeight: finiteNumberOrDefault(ranking.heatWeight, DEFAULT_SEARCH_RANKING.heatWeight),
    recencyWeight: finiteNumberOrDefault(ranking.recencyWeight, DEFAULT_SEARCH_RANKING.recencyWeight),
    halfLifeDays: positiveNumberOrDefault(ranking.halfLifeDays, DEFAULT_SEARCH_RANKING.halfLifeDays),
  };
}

function rankSearchRows(rows, ranking) {
  if (rows.length < 2) return rows;
  const nowMs = Date.now();
  return rows
    .map((row, index) => ({
      row,
      index,
      score: scoreSearchRow(row, ranking, nowMs),
    }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map(item => item.row);
}

function scoreSearchRow(row, ranking, nowMs) {
  const sim = typeof row.distance === 'number'
    ? similarityFromDistance(row.distance)
    : TEXT_SEARCH_SIMILARITY;
  const heat = clamp01(row.heat);
  const recency = recencyFromCreatedAt(row.created_at, ranking.halfLifeDays, nowMs);

  return (
    ranking.simWeight * sim +
    ranking.heatWeight * heat +
    ranking.recencyWeight * recency
  );
}

function similarityFromDistance(distance) {
  const value = Number(distance);
  if (!Number.isFinite(value)) return 0;
  return 1 / (1 + Math.max(0, value));
}

function recencyFromCreatedAt(createdAt, halfLifeDays, nowMs) {
  // Recency must use created_at; decay sweeps rewrite updated_at every 6h.
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return 0;
  const ageDays = Math.max(0, (nowMs - createdMs) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function finiteNumberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function diversityFilter(rows, limit) {
  const selected = [];
  for (const r of rows) {
    if (!isDiverse(r, selected)) continue;
    selected.push(r);
    if (selected.length >= limit) break;
  }
  return selected;
}

function boostSearchRows(rows) {
  if (rows.length === 0) return;
  try {
    ensureStoreDb();
    boostFactHeat(rows.map(r => r.fact_id));
  } catch (err) { log.debug({ err: err.message }, 'boost failed'); }
}

export function renderMemorySearchRows(rows, status = 'active') {
  if (rows.length === 0) return 'No matching facts found.';
  const historical = status !== 'active';
  const statusText = String(status);
  let md = historical
    ? `**⚠ Historical facts (status=${statusText}) — NOT current state**\n\n`
    : '';
  md += historical
    ? `| Subject | Predicate | Object | Type | Scope | Status | Conf | Date |\n|---|---|---|---|---|---|---|---|\n`
    : `| Subject | Predicate | Object | Type | Scope | Conf | Date |\n|---|---|---|---|---|---|---|\n`;
  for (const r of rows) {
    // Redact before truncating so a secret is never split into an unmatched fragment.
    const s = trunc(redactSecrets(r.subject || '?'), 30), p = trunc(redactSecrets(r.predicate), 25), o = trunc(redactSecrets(r.object_text), 50);
    const sc = r.scope || 'project';
    if (historical) {
      md += `| ${s} | ${p} | ${o} | ${r.fact_type} | ${sc} | ${trunc(statusText, 20)} | ${r.confidence} | ${(r.created_at || '').substring(0, 10)} |\n`;
    } else {
      md += `| ${s} | ${p} | ${o} | ${r.fact_type} | ${sc} | ${r.confidence} | ${(r.created_at || '').substring(0, 10)} |\n`;
    }
  }
  const withDetail = rows.filter(r => r.object_detail);
  if (withDetail.length > 0) {
    md += '\n**Details:**\n';
    for (const r of withDetail) {
      md += redactSecrets(`- **${r.subject || '?'}** ${r.predicate}: ${r.object_detail}\n`);
    }
  }
  return md + `\n_${rows.length} results_`;
}

function trunc(str, n) {
  if (!str) return '';
  const s = str.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return s.length > n ? s.substring(0, n - 1) + '...' : s;
}
