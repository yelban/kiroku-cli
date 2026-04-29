import crypto from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { RUN_DIR } from './paths.js';

const DEFAULT_ROUTES_DIR = join(RUN_DIR, 'routes');
const DEFAULT_LEGACY_UPSTREAM_DIR = join(RUN_DIR, 'upstream');
const CACHE_TTL_MS = 30_000;

let _routesDir = DEFAULT_ROUTES_DIR;
let _legacyUpstreamDir = DEFAULT_LEGACY_UPSTREAM_DIR;
const _cache = new Map(); // hash -> { route|null, ts }

export function routesDir() {
  return _routesDir;
}

/**
 * Stable, irreversible identifier for a bearer token. The original token is
 * never written to disk; only the truncated SHA-256 digest is used as a
 * routing key.
 */
export function hashToken(token) {
  if (!token || typeof token !== 'string') return null;
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
}

/**
 * Persist a token -> upstream mapping. Overwrite-only: re-registering the
 * same token replaces the previous entry. Stale entries for tokens that
 * never reappear are harmless and pruned manually.
 */
export function registerRoute({ token, upstream, projectSlug }) {
  if (!token || !upstream) return null;
  const hash = hashToken(token);
  if (!hash) return null;
  mkdirSync(_routesDir, { recursive: true });
  const payload = {
    upstream,
    projectSlug: projectSlug || null,
    registeredAt: new Date().toISOString(),
  };
  const filePath = join(_routesDir, `${hash}.json`);
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  // Atomic replace via rename
  writeFileSync(filePath, JSON.stringify(payload), { mode: 0o600 });
  try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  _cache.set(hash, { route: payload, ts: Date.now() });
  return { hash, ...payload };
}

/**
 * Resolve a token to its registered route, or null. Cached for CACHE_TTL_MS
 * so the hot path (per-request lookup) stays cheap.
 */
export function lookupRoute(token) {
  const hash = hashToken(token);
  if (!hash) return null;
  const cached = _cache.get(hash);
  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return cached.route;
  }
  const filePath = join(_routesDir, `${hash}.json`);
  let route = null;
  if (existsSync(filePath)) {
    try {
      route = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      route = null;
    }
  }
  _cache.set(hash, { route, ts: now });
  return route;
}

/**
 * Best-effort removal of the legacy per-project upstream directory introduced
 * in v1.5.0 ("~/.kiroku/run/upstream/<slug>.txt"). Returns whether anything
 * was removed so the CLI can tell the user.
 */
export function cleanupLegacyUpstreamDir() {
  if (!existsSync(_legacyUpstreamDir)) return { removed: false, path: _legacyUpstreamDir };
  try {
    rmSync(_legacyUpstreamDir, { recursive: true, force: true });
    return { removed: true, path: _legacyUpstreamDir };
  } catch (err) {
    return { removed: false, path: _legacyUpstreamDir, err: err.message };
  }
}

// --- test hooks ---

export function _test_setDirs({ routesDir: r, legacyDir: l } = {}) {
  if (r) _routesDir = r;
  if (l) _legacyUpstreamDir = l;
}

export function _test_resetDirs() {
  _routesDir = DEFAULT_ROUTES_DIR;
  _legacyUpstreamDir = DEFAULT_LEGACY_UPSTREAM_DIR;
}

export function _test_clearCache() {
  _cache.clear();
}
