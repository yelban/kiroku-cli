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
