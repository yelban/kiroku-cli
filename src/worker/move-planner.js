import { DEFAULT_SUPERSEDE_CONFIG } from './supersede-resolver.js';

export function planMoveOperations(items = [], options = {}) {
  return items.map(item => {
    const moveItem = item || {};
    return planMoveOperation({
      ...moveItem,
      operationConfidenceThreshold: moveItem.operationConfidenceThreshold
        ?? options.operationConfidenceThreshold
        ?? DEFAULT_SUPERSEDE_CONFIG.operationConfidenceThreshold,
    });
  });
}

export function planMoveOperation({
  sourceFact = {},
  fromEntity = null,
  toEntity = null,
  fromFacts = [],
  operationConfidenceThreshold = DEFAULT_SUPERSEDE_CONFIG.operationConfidenceThreshold,
} = {}) {
  const threshold = finiteNumberOrDefault(
    operationConfidenceThreshold,
    DEFAULT_SUPERSEDE_CONFIG.operationConfidenceThreshold,
  );
  const operation = normalizeOperation(sourceFact.operation);
  const confidence = confidenceOf(sourceFact);
  const sourceFactId = idOf(sourceFact);
  const fromEntityId = idOf(fromEntity);
  const toEntityId = idOf(toEntity);
  const basePlan = {
    action: 'skip',
    result: 'skipped',
    operation,
    confidence,
    operationConfidenceThreshold: threshold,
    sourceFactId,
    targetId: toEntityId,
    targetType: 'entity',
    fromEntityId,
    toEntityId,
    targetFactIds: [],
    supersedeFacts: [],
    aliasMerge: null,
  };

  if (operation !== 'move') {
    return { ...basePlan, reason: 'unsupported_operation' };
  }
  if (!fromEntityId || !toEntityId) {
    return { ...basePlan, reason: 'missing_move_endpoint' };
  }
  if (confidence < threshold) {
    return { ...basePlan, reason: 'operation_confidence_below_threshold' };
  }

  const supersedeFacts = fromFacts
    .filter(fact => fact && (fact.status ?? 'active') === 'active')
    .map(fact => idOf(fact))
    .filter(factId => factId && factId !== sourceFactId)
    .map(factId => ({ factId, status: 'superseded' }));
  const targetFactIds = supersedeFacts.map(item => item.factId);

  return {
    ...basePlan,
    action: 'move',
    result: 'applied',
    targetFactIds,
    supersedeFacts,
    aliasMerge: planAliasMerge(fromEntity, toEntity),
  };
}

function planAliasMerge(fromEntity, toEntity) {
  const currentAliases = aliasesOf(toEntity);
  const candidates = [
    canonicalNameOf(fromEntity),
    ...aliasesOf(fromEntity),
  ].filter(Boolean);
  const targetCanonical = canonicalNameOf(toEntity);
  const aliases = [...currentAliases];
  const addedAliases = [];

  for (const alias of candidates) {
    if (alias === targetCanonical || aliases.includes(alias)) continue;
    aliases.push(alias);
    addedAliases.push(alias);
  }

  return {
    targetEntityId: idOf(toEntity),
    aliases,
    addedAliases,
  };
}

function aliasesOf(entity) {
  if (!entity) return [];
  if (Array.isArray(entity.aliases)) return entity.aliases.filter(Boolean);
  if (Array.isArray(entity.aliasesJson)) return entity.aliasesJson.filter(Boolean);
  const raw = entity.aliases_json ?? entity.aliasesJson;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function canonicalNameOf(entity) {
  return entity?.canonicalName ?? entity?.canonical_name ?? entity?.name ?? null;
}

function idOf(value) {
  return value?.id ?? value?.fact_id ?? value?.factId ?? null;
}

function normalizeOperation(operation) {
  return String(operation ?? 'add').toLowerCase().trim() || 'add';
}

function confidenceOf(fact) {
  const confidence = Number(fact?.confidence);
  return Number.isFinite(confidence) ? confidence : 0;
}

function finiteNumberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
