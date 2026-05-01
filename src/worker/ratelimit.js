// Anthropic ratelimit header parsing + retry-after derivation.
//
// Anthropic exposes the live rate limit state on every response via
// anthropic-ratelimit-unified-* headers. On 429 we ideally sleep until
// the named reset point rather than blindly exponential-backing off,
// because the 5h window often opens up exactly at the reset epoch.

const RESET_KEYS = [
  'anthropic-ratelimit-unified-overage-reset',  // shortest, most precise
  'anthropic-ratelimit-unified-5h-reset',
  'anthropic-ratelimit-unified-7d-reset',
];

const MAX_BACKOFF_MS = 60_000;       // cap per-attempt sleep
const MIN_BACKOFF_MS = 1_000;        // never sleep less than 1s on 429

// Hash-grab the per-window utilization + reset timestamps so callers can
// log them or feed them to a future adaptive throttle.
export function parseRatelimit(headers) {
  if (!headers) return null;
  const out = {};
  for (const key of [
    ['fivehUtil', 'anthropic-ratelimit-unified-5h-utilization'],
    ['sevenDUtil', 'anthropic-ratelimit-unified-7d-utilization'],
    ['sevenDSonnetUtil', 'anthropic-ratelimit-unified-7d_sonnet-utilization'],
    ['overageUtil', 'anthropic-ratelimit-unified-overage-utilization'],
  ]) {
    const v = headers[key[1]];
    if (v != null) {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) out[key[0]] = n;
    }
  }
  for (const key of [
    ['fivehReset', 'anthropic-ratelimit-unified-5h-reset'],
    ['sevenDReset', 'anthropic-ratelimit-unified-7d-reset'],
    ['overageReset', 'anthropic-ratelimit-unified-overage-reset'],
  ]) {
    const v = headers[key[1]];
    if (v != null) {
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) out[key[0]] = n;
    }
  }
  const claim = headers['anthropic-ratelimit-unified-representative-claim'];
  if (claim) out.claim = claim;
  return Object.keys(out).length ? out : null;
}

// Pick the best sleep duration on 429 / rate_limit_error.
// Priority: HTTP standard `retry-after` > closest anthropic reset header > null.
// Returns ms, or null if no signal.
export function deriveRetryAfterMs(headers, now = Date.now()) {
  if (!headers) return null;

  const ra = headers['retry-after'];
  if (ra != null) {
    const s = parseInt(ra, 10);
    if (!Number.isNaN(s) && s > 0) {
      return Math.max(MIN_BACKOFF_MS, Math.min(s * 1000, MAX_BACKOFF_MS));
    }
  }

  // Try each reset header; pick the soonest future reset.
  let soonestMs = null;
  for (const key of RESET_KEYS) {
    const v = headers[key];
    if (v == null) continue;
    const epochSec = parseInt(v, 10);
    if (Number.isNaN(epochSec)) continue;
    const ms = epochSec * 1000 - now;
    if (ms <= 0) continue;
    if (soonestMs == null || ms < soonestMs) soonestMs = ms;
  }
  if (soonestMs == null) return null;
  return Math.max(MIN_BACKOFF_MS, Math.min(soonestMs, MAX_BACKOFF_MS));
}
