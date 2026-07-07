export const DEFAULT_SUPERSEDE_CONFIG = Object.freeze({
  enabled: true,
  semanticThreshold: 0.58,
  stateTaskThreshold: 0.8,
});

const STATE_TASK_TYPES = new Set(['state', 'task']);
const REPLACEMENT_CUES = [
  'standardize',
  'standardizes',
  'standardized',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
  'replace',
  'replaces',
  'replaced',
  'switch',
  'switches',
  'switched',
  'migrate',
  'migrates',
  'migrated',
  'move',
  'moves',
  'moved',
  'remove',
  'removes',
  'removed',
  'drop',
  'drops',
  'dropped',
  'deprecate',
  'deprecates',
  'deprecated',
  'no longer',
  'now ',
  // CJK replacement cues — kiroku's primary conversation language is zh-TW;
  // substring matching needs no word segmentation.
  '改用',
  '換成',
  '換用',
  '改成',
  '取代',
  '替換',
  '遷移',
  '搬到',
  '移到',
  '移除',
  '刪除',
  '棄用',
  '廢棄',
  '不再',
  '修好',
  '修復',
  '已修',
  '升級到',
  '降級到',
];

export function normalizeSupersedeConfig(config = {}) {
  return {
    enabled: config.enabled ?? DEFAULT_SUPERSEDE_CONFIG.enabled,
    semanticThreshold: finiteNumberOrDefault(
      config.semanticThreshold,
      DEFAULT_SUPERSEDE_CONFIG.semanticThreshold,
    ),
    stateTaskThreshold: finiteNumberOrDefault(
      config.stateTaskThreshold,
      DEFAULT_SUPERSEDE_CONFIG.stateTaskThreshold,
    ),
  };
}

export function resolveSemanticSupersedes(candidate, activeFacts = [], config = {}) {
  const cfg = normalizeSupersedeConfig(config);
  if (!cfg.enabled || !hasEmbedding(candidate?.embedding)) return [];

  return activeFacts.map(target => resolveOne(candidate, target, cfg));
}

function resolveOne(candidate, target, config) {
  const targetFactId = target?.id ?? target?.fact_id ?? target?.factId ?? null;
  const sourceFactId = candidate?.id ?? candidate?.fact_id ?? candidate?.factId ?? null;
  const baseDecision = { action: 'none', sourceFactId, targetFactId };

  if (!target || targetFactId === sourceFactId) {
    return { ...baseDecision, reason: 'same_fact' };
  }
  if (!sameSubject(candidate, target)) {
    return { ...baseDecision, reason: 'different_subject' };
  }
  if (objectTextOf(candidate) === objectTextOf(target)) {
    return { ...baseDecision, reason: 'same_object' };
  }
  if (!hasEmbedding(target.embedding)) {
    return { ...baseDecision, reason: 'missing_target_embedding' };
  }

  const targetType = factTypeOf(target);
  const threshold = STATE_TASK_TYPES.has(targetType)
    ? config.stateTaskThreshold
    : config.semanticThreshold;
  const cosine = cosineSimilarity(candidate.embedding, target.embedding);

  if (cosine < threshold) {
    return { ...baseDecision, reason: 'below_threshold', cosine, threshold };
  }
  if (!hasReplacementSignal(candidate, target)) {
    return { ...baseDecision, reason: 'no_replacement_signal', cosine, threshold };
  }

  return {
    action: STATE_TASK_TYPES.has(targetType) ? 'archive' : 'supersede',
    sourceFactId,
    targetFactId,
    cosine,
    threshold,
  };
}

function sameSubject(candidate, target) {
  const candidateSubject = candidate?.subjectEntityId ?? candidate?.subject_entity_id;
  const targetSubject = target?.subjectEntityId ?? target?.subject_entity_id;
  return candidateSubject && targetSubject && candidateSubject === targetSubject;
}

function objectTextOf(fact) {
  return fact?.objectText ?? fact?.object_text ?? fact?.object ?? '';
}

function factTypeOf(fact) {
  return fact?.factType ?? fact?.fact_type ?? 'semantic';
}

function hasReplacementSignal(candidate, target) {
  if (STATE_TASK_TYPES.has(factTypeOf(target))) return true;
  if (normalizePredicate(candidate?.predicate) === normalizePredicate(target?.predicate)) return true;

  const candidateText = `${candidate?.predicate ?? ''} ${objectTextOf(candidate)}`.toLowerCase();
  return REPLACEMENT_CUES.some(cue => candidateText.includes(cue));
}

function normalizePredicate(predicate = '') {
  return String(predicate).toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasEmbedding(embedding) {
  return embedding && typeof embedding.length === 'number' && embedding.length > 0;
}

function finiteNumberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cosineSimilarity(a, b) {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i++) dot += a[i] * b[i];
  return dot;
}
