const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;

function tokenize(text) {
  return new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 1));
}

function jaccardSimilarity(a, b) {
  let intersection = 0;
  for (const x of a) { if (b.has(x)) intersection++; }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isDiverse(candidate, selected) {
  const candSubject = (candidate.subject || '').toLowerCase();
  for (const s of selected) {
    if ((s.subject || '').toLowerCase() !== candSubject) continue; // different subject = always diverse
    const candWords = tokenize(candidate.predicate + ' ' + candidate.object_text);
    const selWords = tokenize(s.predicate + ' ' + s.object_text);
    if (jaccardSimilarity(candWords, selWords) > 0.5) return false;
  }
  return true;
}

function estimateTokens(line) {
  const cjk = (line.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  return Math.ceil(cjk * 1.5 + (line.length - cjk) / 4);
}

function formatLine(r) {
  const detail = r.object_detail ? ` — ${r.object_detail}` : '';
  const scope = r.scope === 'global' ? ' [global]' : '';
  const age = formatAgeMarker(r.created_at);
  return `[${r.fact_type}] ${r.subject || '?'} ${r.predicate} ${r.object_text}${detail}${scope}${age}`;
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

export function getProjectBrief(db, projectId, config) {
  return renderProjectBriefRows(selectProjectBriefRows(db, projectId, config));
}

export function selectProjectBriefRows(db, projectId, config) {
  // Accept both old (maxFacts number) and new (config object) signatures
  let maxFacts, maxTokens;
  if (typeof config === 'number') {
    maxFacts = config;
    maxTokens = 0;
  } else {
    maxFacts = config?.maxFacts || 50;
    maxTokens = config?.maxTokens || 0;
  }

  // Fetch 3× candidates for diversity filtering
  const fetchLimit = maxFacts * 3;
  const candidates = db.prepare(`
    SELECT f.id as fact_id, f.project_id, f.fact_type, f.predicate, f.object_text,
           f.object_detail, f.confidence, f.heat, f.scope, f.created_at,
           f.access_count, e.canonical_name as subject
    FROM facts f
    LEFT JOIN entities e ON f.subject_entity_id = e.id
    WHERE f.status = 'active'
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
      f.heat * (1.0 + MIN(f.access_count, 20) * 0.1) DESC
    LIMIT ?
  `).all(projectId, fetchLimit);

  if (!candidates.length) return [];

  const selected = [];
  let tokenCount = 0;

  for (const r of candidates) {
    if (!isDiverse(r, selected)) continue;

    const line = formatLine(r);
    const lineTokens = estimateTokens(line);

    if (maxTokens > 0 && tokenCount + lineTokens > maxTokens) break;

    selected.push(r);
    tokenCount += lineTokens;

    if (selected.length >= maxFacts) break;
  }

  return selected;
}

export function renderProjectBriefRows(rows) {
  if (!rows.length) return 'No project context available yet.';
  const lines = rows.map(formatLine);
  return `# Project Memory Brief (${rows.length} facts)\n\n${lines.join('\n')}`;
}

// Exported for reuse in memory-search.js
export { isDiverse, tokenize, jaccardSimilarity, estimateTokens };
