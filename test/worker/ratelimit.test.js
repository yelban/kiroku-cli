import { describe, it, expect } from 'vitest';
import { parseRatelimit, deriveRetryAfterMs } from '../../src/worker/ratelimit.js';

describe('parseRatelimit', () => {
  it('returns null for empty/missing headers', () => {
    expect(parseRatelimit(null)).toBeNull();
    expect(parseRatelimit({})).toBeNull();
  });

  it('extracts utilization floats', () => {
    const r = parseRatelimit({
      'anthropic-ratelimit-unified-5h-utilization': '0.31',
      'anthropic-ratelimit-unified-7d-utilization': '0.63',
      'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.01',
    });
    expect(r).toEqual({ fivehUtil: 0.31, sevenDUtil: 0.63, sevenDSonnetUtil: 0.01 });
  });

  it('extracts reset epoch timestamps as ints', () => {
    const r = parseRatelimit({
      'anthropic-ratelimit-unified-5h-reset': '1777643400',
    });
    expect(r.fivehReset).toBe(1777643400);
  });

  it('captures representative claim', () => {
    const r = parseRatelimit({
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    });
    expect(r.claim).toBe('five_hour');
  });

  it('skips malformed values', () => {
    const r = parseRatelimit({
      'anthropic-ratelimit-unified-5h-utilization': 'oops',
      'anthropic-ratelimit-unified-7d-utilization': '0.5',
    });
    expect(r).toEqual({ sevenDUtil: 0.5 });
  });
});

describe('deriveRetryAfterMs', () => {
  it('returns null without headers', () => {
    expect(deriveRetryAfterMs(null)).toBeNull();
    expect(deriveRetryAfterMs({})).toBeNull();
  });

  it('honors HTTP retry-after seconds', () => {
    expect(deriveRetryAfterMs({ 'retry-after': '15' })).toBe(15_000);
  });

  it('clamps retry-after to MAX_BACKOFF (60s)', () => {
    expect(deriveRetryAfterMs({ 'retry-after': '3600' })).toBe(60_000);
  });

  it('floors retry-after to MIN_BACKOFF (1s)', () => {
    // retry-after: 0 means no signal → returns null (s>0 guard)
    expect(deriveRetryAfterMs({ 'retry-after': '0' })).toBeNull();
  });

  it('falls through to anthropic 5h reset header', () => {
    const now = 1_777_643_000_000;
    const epochSec = 1_777_643_005;  // 5s in future
    const ms = deriveRetryAfterMs(
      { 'anthropic-ratelimit-unified-5h-reset': String(epochSec) }, now);
    expect(ms).toBe(5_000);
  });

  it('picks soonest reset across multiple windows', () => {
    const now = 1_777_643_000_000;
    const ms = deriveRetryAfterMs({
      'anthropic-ratelimit-unified-5h-reset': '1777643060',     // +60s
      'anthropic-ratelimit-unified-overage-reset': '1777643010', // +10s
      'anthropic-ratelimit-unified-7d-reset': '1777700000',     // far future
    }, now);
    expect(ms).toBe(10_000);
  });

  it('skips reset headers that are already in the past', () => {
    const now = 1_777_643_000_000;
    const ms = deriveRetryAfterMs(
      { 'anthropic-ratelimit-unified-5h-reset': '1777642000' }, now);
    expect(ms).toBeNull();
  });

  it('prefers retry-after over reset headers when both present', () => {
    const now = 1_777_643_000_000;
    const ms = deriveRetryAfterMs({
      'retry-after': '5',
      'anthropic-ratelimit-unified-5h-reset': '1777643060',
    }, now);
    expect(ms).toBe(5_000);
  });

  it('clamps reset-derived sleep to MAX_BACKOFF', () => {
    const now = 1_777_643_000_000;
    const ms = deriveRetryAfterMs(
      { 'anthropic-ratelimit-unified-5h-reset': '1777743000' }, now);
    expect(ms).toBe(60_000);
  });
});
