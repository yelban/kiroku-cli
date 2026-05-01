// Per-model prompt-cache health tracker.
//
// Anthropic claims to support prompt caching on every Claude 4.x model,
// but Haiku 4.5 (as of 2026-05) silently no-ops cache_control across both
// OAuth and API key paths: cache_creation_input_tokens stays 0, every
// call charges the full system prompt. Sending cache_control on a broken
// model still costs nothing extra, but adds clutter and gives users a
// false sense of cost amortization.
//
// We track creation/read counts per model and disable cache_control for
// models that have written several cache entries with zero hits. After
// a 24h cooldown the model is rechecked once in case the upstream issue
// is resolved.

const BROKEN_TTL_MS = 24 * 60 * 60 * 1000;
const CREATIONS_BEFORE_BROKEN = 3;

const _state = new Map(); // model -> { creations, reads, brokenSince, retried }

function getState(model) {
  let s = _state.get(model);
  if (!s) {
    s = { creations: 0, reads: 0, brokenSince: null, retried: false };
    _state.set(model, s);
  }
  return s;
}

export function recordUsage(model, usage, now = Date.now()) {
  if (!model || !usage) return;
  const s = getState(model);
  if ((usage.cache_creation_input_tokens || 0) > 0) s.creations += 1;
  if ((usage.cache_read_input_tokens || 0) > 0) s.reads += 1;

  // First-time detection: enough creations with zero reads → broken.
  if (!s.brokenSince && s.creations >= CREATIONS_BEFORE_BROKEN && s.reads === 0) {
    s.brokenSince = now;
  }

  // Recovery probe: if broken model started reporting reads, mark healthy.
  if (s.brokenSince && s.reads > 0) {
    s.brokenSince = null;
    s.retried = false;
  }
}

export function shouldUseCacheControl(model, now = Date.now()) {
  if (!model) return true;
  const s = _state.get(model);
  if (!s?.brokenSince) return true;
  // Cooldown elapsed → allow one retry probe; if it caches, recordUsage
  // will clear brokenSince. Otherwise the next recordUsage hits the
  // creations≥3+reads=0 branch again and re-marks broken.
  if (now - s.brokenSince > BROKEN_TTL_MS && !s.retried) {
    s.retried = true;
    return true;
  }
  return false;
}

export function getCacheHealth(model) {
  if (!model) return null;
  const s = _state.get(model);
  if (!s) return { model, creations: 0, reads: 0, status: 'unknown' };
  return {
    model,
    creations: s.creations,
    reads: s.reads,
    status: s.brokenSince ? 'broken' : (s.reads > 0 ? 'healthy' : 'warming'),
    brokenSince: s.brokenSince,
  };
}

export function resetCacheHealth() {
  _state.clear();
}
