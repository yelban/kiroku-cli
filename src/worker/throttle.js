export function createThrottle(now = () => Date.now()) {
  const window = [];

  function check(throttleConfig) {
    if (!throttleConfig?.enabled) return true;
    const t = now();
    const cutoff = t - 60_000;
    while (window.length && window[0] < cutoff) window.shift();
    const limit = throttleConfig.maxCallsPerMinute || 20;
    if (window.length >= limit) return false;
    window.push(t);
    return true;
  }

  return {
    check,
    size: () => window.length,
    reset: () => { window.length = 0; },
  };
}
