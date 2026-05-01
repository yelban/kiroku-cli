import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordUsage,
  shouldUseCacheControl,
  getCacheHealth,
  resetCacheHealth,
} from '../../src/worker/cache-health.js';

beforeEach(() => resetCacheHealth());

describe('cache-health', () => {
  it('default: unknown model uses cache_control', () => {
    expect(shouldUseCacheControl('claude-test-model')).toBe(true);
  });

  it('healthy model (creations + reads): keeps cache_control on', () => {
    recordUsage('m', { cache_creation_input_tokens: 2522, cache_read_input_tokens: 0 });
    recordUsage('m', { cache_creation_input_tokens: 0, cache_read_input_tokens: 2522 });
    recordUsage('m', { cache_creation_input_tokens: 0, cache_read_input_tokens: 2522 });
    expect(shouldUseCacheControl('m')).toBe(true);
    expect(getCacheHealth('m').status).toBe('healthy');
  });

  it('warming (creation but no reads yet): still uses cache_control', () => {
    recordUsage('m', { cache_creation_input_tokens: 2522, cache_read_input_tokens: 0 });
    expect(shouldUseCacheControl('m')).toBe(true);
    expect(getCacheHealth('m').status).toBe('warming');
  });

  it('after 3 creations with 0 reads: marks broken, disables cache_control', () => {
    for (let i = 0; i < 3; i++) {
      recordUsage('m', { cache_creation_input_tokens: 2522, cache_read_input_tokens: 0 });
    }
    expect(getCacheHealth('m').status).toBe('broken');
    expect(shouldUseCacheControl('m')).toBe(false);
  });

  it('broken model recovers when reads start coming in', () => {
    for (let i = 0; i < 3; i++) {
      recordUsage('m', { cache_creation_input_tokens: 2522, cache_read_input_tokens: 0 });
    }
    expect(shouldUseCacheControl('m')).toBe(false);
    // Even though we said don't use cache_control, the next call upstream
    // could still report a read (e.g. backend rolled out a fix).
    recordUsage('m', { cache_creation_input_tokens: 0, cache_read_input_tokens: 2522 });
    expect(getCacheHealth('m').status).toBe('healthy');
    expect(shouldUseCacheControl('m')).toBe(true);
  });

  it('per-model isolation: Haiku broken does not affect Sonnet', () => {
    for (let i = 0; i < 3; i++) {
      recordUsage('haiku', { cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 });
    }
    recordUsage('sonnet', { cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 });
    recordUsage('sonnet', { cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 });
    expect(shouldUseCacheControl('haiku')).toBe(false);
    expect(shouldUseCacheControl('sonnet')).toBe(true);
  });

  it('after 24h cooldown, broken model gets one retry probe', () => {
    const t0 = 1_000_000_000;
    for (let i = 0; i < 3; i++) {
      recordUsage('m', { cache_creation_input_tokens: 2522, cache_read_input_tokens: 0 }, t0);
    }
    expect(shouldUseCacheControl('m', t0)).toBe(false);

    const after24h = t0 + 24 * 60 * 60 * 1000 + 1;
    expect(shouldUseCacheControl('m', after24h)).toBe(true);     // probe allowed
    expect(shouldUseCacheControl('m', after24h)).toBe(false);    // only one probe
  });

  it('handles missing or malformed usage safely', () => {
    expect(() => recordUsage('m', undefined)).not.toThrow();
    expect(() => recordUsage('m', null)).not.toThrow();
    expect(() => recordUsage('m', {})).not.toThrow();
    expect(() => recordUsage(null, { cache_creation_input_tokens: 100 })).not.toThrow();
    expect(getCacheHealth('m').creations).toBe(0);
  });
});
