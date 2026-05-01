import { describe, it, expect } from 'vitest';
import { createThrottle } from '../../src/worker/throttle.js';

describe('createThrottle', () => {
  it('passes through when disabled', () => {
    const t = createThrottle();
    for (let i = 0; i < 100; i++) {
      expect(t.check({ enabled: false, maxCallsPerMinute: 5 })).toBe(true);
    }
    expect(t.size()).toBe(0);
  });

  it('allows up to maxCallsPerMinute then blocks', () => {
    const t = createThrottle();
    const cfg = { enabled: true, maxCallsPerMinute: 3 };
    expect(t.check(cfg)).toBe(true);
    expect(t.check(cfg)).toBe(true);
    expect(t.check(cfg)).toBe(true);
    expect(t.check(cfg)).toBe(false);
    expect(t.size()).toBe(3);
  });

  it('expires entries older than 60s', () => {
    let nowMs = 1_000_000;
    const t = createThrottle(() => nowMs);
    const cfg = { enabled: true, maxCallsPerMinute: 2 };
    expect(t.check(cfg)).toBe(true);
    expect(t.check(cfg)).toBe(true);
    expect(t.check(cfg)).toBe(false);

    nowMs += 60_001;
    expect(t.check(cfg)).toBe(true);
    expect(t.size()).toBe(1);
  });

  it('reset clears the window', () => {
    const t = createThrottle();
    const cfg = { enabled: true, maxCallsPerMinute: 1 };
    t.check(cfg);
    expect(t.check(cfg)).toBe(false);
    t.reset();
    expect(t.check(cfg)).toBe(true);
  });

  it('default limit is 20 when maxCallsPerMinute missing', () => {
    const t = createThrottle();
    const cfg = { enabled: true };
    for (let i = 0; i < 20; i++) {
      expect(t.check(cfg)).toBe(true);
    }
    expect(t.check(cfg)).toBe(false);
  });
});

describe('createThrottle adaptive (ratelimit-aware)', () => {
  const cfg = (over = {}) => ({ enabled: true, maxCallsPerMinute: 20, adaptive: true, ...over });

  it('without ratelimit data, behaves like normal throttle', () => {
    const t = createThrottle();
    expect(t.effectiveLimit(cfg())).toBe(20);
  });

  it('low utilization (<80%) keeps base limit', () => {
    const t = createThrottle();
    t.noteRatelimit({ fivehUtil: 0.5, sevenDUtil: 0.6 });
    expect(t.effectiveLimit(cfg())).toBe(20);
  });

  it('utilization >= 80% drops to 50% (ladder step 1)', () => {
    const t = createThrottle();
    t.noteRatelimit({ fivehUtil: 0.85 });
    expect(t.effectiveLimit(cfg())).toBe(10);
  });

  it('utilization >= 95% drops to 25% (ladder step 2)', () => {
    const t = createThrottle();
    t.noteRatelimit({ fivehUtil: 0.97 });
    expect(t.effectiveLimit(cfg())).toBe(5);
  });

  it('picks the highest utilization across windows', () => {
    const t = createThrottle();
    t.noteRatelimit({ fivehUtil: 0.5, sevenDUtil: 0.92, overageUtil: 0.1 });
    expect(t.effectiveLimit(cfg())).toBe(10);  // 7d at 92% drives it
  });

  it('opt-out via adaptive:false ignores ratelimit pressure', () => {
    const t = createThrottle();
    t.noteRatelimit({ fivehUtil: 0.97 });
    expect(t.effectiveLimit(cfg({ adaptive: false }))).toBe(20);
  });

  it('check() respects effective limit under pressure', () => {
    const t = createThrottle();
    t.noteRatelimit({ fivehUtil: 0.97 });
    // limit becomes 5
    for (let i = 0; i < 5; i++) expect(t.check(cfg())).toBe(true);
    expect(t.check(cfg())).toBe(false);
  });

  it('pressure expires after 5 minutes', () => {
    let nowMs = 1_000_000;
    const t = createThrottle(() => nowMs);
    t.noteRatelimit({ fivehUtil: 0.95 });
    expect(t.effectiveLimit(cfg())).toBe(5);
    nowMs += 5 * 60 * 1000 + 1;
    expect(t.effectiveLimit(cfg())).toBe(20);  // back to base
  });

  it('reset clears both window and pressure', () => {
    const t = createThrottle();
    t.noteRatelimit({ fivehUtil: 0.95 });
    t.reset();
    expect(t.pressure()).toBeNull();
    expect(t.effectiveLimit(cfg())).toBe(20);
  });

  it('handles missing or malformed ratelimit safely', () => {
    const t = createThrottle();
    expect(() => t.noteRatelimit(null)).not.toThrow();
    expect(() => t.noteRatelimit(undefined)).not.toThrow();
    expect(() => t.noteRatelimit({})).not.toThrow();
    expect(() => t.noteRatelimit({ fivehUtil: 'oops' })).not.toThrow();
    expect(t.pressure()).toBeNull();
  });
});
