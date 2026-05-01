// Pressure ladder: when the most-stressed window's utilization climbs,
// we throttle the worker to a fraction of its configured budget so the
// remaining quota gets reserved for the user's foreground chat traffic.
const PRESSURE_TTL_MS = 5 * 60 * 1000;          // ratelimit info older than this is ignored
const PRESSURE_LADDER = [
  { threshold: 0.95, scale: 0.25 },             // last 5% → 25% of base rate
  { threshold: 0.80, scale: 0.50 },             // last 20% → 50% of base rate
];

function pickScale(util) {
  for (const step of PRESSURE_LADDER) {
    if (util >= step.threshold) return step.scale;
  }
  return 1;
}

export function createThrottle(now = () => Date.now()) {
  const window = [];
  let pressure = null;  // { util, recordedAt }

  function effectiveLimit(throttleConfig) {
    const base = throttleConfig.maxCallsPerMinute || 20;
    if (throttleConfig.adaptive === false) return base;
    if (!pressure) return base;
    if (now() - pressure.recordedAt > PRESSURE_TTL_MS) return base;
    return Math.max(1, Math.ceil(base * pickScale(pressure.util)));
  }

  function check(throttleConfig) {
    if (!throttleConfig?.enabled) return true;
    const t = now();
    const cutoff = t - 60_000;
    while (window.length && window[0] < cutoff) window.shift();
    const limit = effectiveLimit(throttleConfig);
    if (window.length >= limit) return false;
    window.push(t);
    return true;
  }

  // Feed every parsed ratelimit response (from parseRatelimit). We track
  // the highest utilization across the windows we care about — whichever
  // is closest to 100% drives the pressure decision.
  function noteRatelimit(rl) {
    if (!rl) return;
    const candidates = [];
    for (const k of ['fivehUtil', 'sevenDUtil', 'overageUtil']) {
      if (typeof rl[k] === 'number') candidates.push(rl[k]);
    }
    if (candidates.length === 0) return;
    const util = Math.max(...candidates);
    pressure = { util, recordedAt: now() };
  }

  return {
    check,
    size: () => window.length,
    reset: () => { window.length = 0; pressure = null; },
    noteRatelimit,
    effectiveLimit,
    pressure: () => pressure,
  };
}

// Module-level singleton shared between worker.js (gates pollQueue) and
// extractor.js (feeds ratelimit observations after each anthropic call).
export const sharedThrottle = createThrottle();
