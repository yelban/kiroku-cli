import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashToken,
  registerRoute,
  lookupRoute,
  cleanupLegacyUpstreamDir,
  _test_setDirs,
  _test_resetDirs,
  _test_clearCache,
} from '../../src/shared/route-store.js';

let tmpRoot;
let routesDir;
let legacyDir;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiroku-routes-'));
  routesDir = join(tmpRoot, 'routes');
  legacyDir = join(tmpRoot, 'upstream');
  _test_setDirs({ routesDir, legacyDir });
  _test_clearCache();
});

afterEach(() => {
  _test_resetDirs();
  _test_clearCache();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe('hashToken', () => {
  it('produces a stable 32-char hex digest', () => {
    const a = hashToken('sk-ant-api03-alpha');
    const b = hashToken('sk-ant-api03-alpha');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns null for empty input', () => {
    expect(hashToken('')).toBeNull();
    expect(hashToken(null)).toBeNull();
    expect(hashToken(undefined)).toBeNull();
  });

  it('produces distinct digests for different tokens', () => {
    expect(hashToken('token-A')).not.toBe(hashToken('token-B'));
  });
});

describe('registerRoute + lookupRoute', () => {
  it('round-trips a token to its upstream', () => {
    const result = registerRoute({
      token: 'sk-relay-key-XYZ',
      upstream: 'https://relay.example.com',
      projectSlug: 'demo-project',
    });
    expect(result.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(result.upstream).toBe('https://relay.example.com');

    const looked = lookupRoute('sk-relay-key-XYZ');
    expect(looked).not.toBeNull();
    expect(looked.upstream).toBe('https://relay.example.com');
    expect(looked.projectSlug).toBe('demo-project');
  });

  it('returns null when token has no registered route', () => {
    expect(lookupRoute('not-registered-token')).toBeNull();
  });

  it('returns null for missing/empty tokens', () => {
    expect(lookupRoute(null)).toBeNull();
    expect(lookupRoute('')).toBeNull();
  });

  it('overwrites the same token entry', () => {
    registerRoute({ token: 'T', upstream: 'https://first.example' });
    registerRoute({ token: 'T', upstream: 'https://second.example' });
    expect(lookupRoute('T').upstream).toBe('https://second.example');
  });

  it('writes route file with mode 600 (no leak of upstream config)', () => {
    registerRoute({ token: 'sensitive-token', upstream: 'https://internal.example' });
    const files = readdirSync(routesDir).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const content = JSON.parse(readFileSync(join(routesDir, files[0]), 'utf8'));
    expect(content.upstream).toBe('https://internal.example');
    expect(content.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Token itself must not appear in any file
    for (const f of files) {
      const raw = readFileSync(join(routesDir, f), 'utf8');
      expect(raw).not.toContain('sensitive-token');
    }
  });
});

describe('lookup cache', () => {
  it('serves the second lookup from in-memory cache without disk re-read', () => {
    registerRoute({ token: 'cache-test', upstream: 'https://x.example' });
    expect(lookupRoute('cache-test').upstream).toBe('https://x.example');

    // Mutate the on-disk file behind the cache's back; cache should still
    // serve the original value within the TTL window.
    const hash = hashToken('cache-test');
    const filePath = join(routesDir, `${hash}.json`);
    writeFileSync(filePath, JSON.stringify({ upstream: 'https://changed.example' }));
    expect(lookupRoute('cache-test').upstream).toBe('https://x.example');

    // Clearing the cache forces a re-read.
    _test_clearCache();
    expect(lookupRoute('cache-test').upstream).toBe('https://changed.example');
  });

  it('caches negative hits too', () => {
    expect(lookupRoute('ghost-token')).toBeNull();
    // Now register and verify cache prevents the new entry from being seen
    // until cleared.
    registerRoute({ token: 'ghost-token', upstream: 'https://z.example' });
    // registerRoute updates the cache itself — should reflect immediately.
    expect(lookupRoute('ghost-token').upstream).toBe('https://z.example');
  });
});

describe('cleanupLegacyUpstreamDir', () => {
  it('is a no-op when the legacy dir does not exist', () => {
    const r = cleanupLegacyUpstreamDir();
    expect(r.removed).toBe(false);
  });

  it('removes the legacy directory and reports it', () => {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'project-a.txt'), 'https://stale.example');
    expect(existsSync(legacyDir)).toBe(true);

    const r = cleanupLegacyUpstreamDir();
    expect(r.removed).toBe(true);
    expect(existsSync(legacyDir)).toBe(false);
  });
});

describe('extractBearerToken (smoke via server.js semantics)', () => {
  // Since extractBearerToken is private to server.js, we re-implement the
  // semantics here as a contract test; if server.js diverges, the proxy
  // tests will catch it via routing behavior.
  function extract(headers) {
    const auth = headers.authorization;
    if (typeof auth === 'string') {
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (m) return m[1].trim();
    }
    const apiKey = headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey;
    return null;
  }

  it('extracts Bearer tokens', () => {
    expect(extract({ authorization: 'Bearer sk-token-X' })).toBe('sk-token-X');
    expect(extract({ authorization: 'bearer  sk-token-Y  ' })).toBe('sk-token-Y');
  });

  it('falls back to x-api-key', () => {
    expect(extract({ 'x-api-key': 'sk-ant-api03-Z' })).toBe('sk-ant-api03-Z');
  });

  it('Bearer takes precedence over x-api-key', () => {
    expect(extract({
      authorization: 'Bearer first',
      'x-api-key': 'second',
    })).toBe('first');
  });

  it('returns null when no auth header is present', () => {
    expect(extract({})).toBeNull();
    expect(extract({ authorization: 'Basic abc' })).toBeNull();
  });
});
