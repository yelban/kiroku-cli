import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { createLogger } from '../shared/logger.js';

const log = createLogger('keepalive');

const TICK_INTERVAL_MS = 30_000;
const MAX_CONSECUTIVE_ERRORS = 3;

// Headers that must be forwarded so the request looks identical to a real
// Claude Code call (auth + version negotiation + UA spoofing).
const FORWARD_HEADERS = [
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  'user-agent',
];

const _snapshots = new Map(); // projectId -> Snapshot
let _tickTimer = null;
let _config = null;
let _httpClient = defaultHttpClient; // overridable for tests
let _started = false;

/**
 * Capture a replayable snapshot of the latest mainline request for a project.
 * Only stores when authMode === 'api_key' (PRD R1) and, when configured,
 * only when the body actually carries cache_control breakpoints.
 */
export function captureSnapshot({ projectId, body, headers, upstreamUrl, authMode }) {
  if (!_started || !_config?.enabled) return;
  if (authMode !== 'api_key') return;
  if (!_config.apiKeyOnly && authMode === 'session') return;
  if (!projectId) return;
  if (!body || typeof body !== 'object') return;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return;

  if (_config.onlyWithCacheControl && !hasCacheControl(body)) {
    return;
  }

  const apiKey = headers['x-api-key'];
  if (!apiKey) return;

  const forwardedHeaders = {};
  for (const h of FORWARD_HEADERS) {
    if (headers[h]) forwardedHeaders[h] = headers[h];
  }

  const now = Date.now();
  const existing = _snapshots.get(projectId);

  _snapshots.set(projectId, {
    projectId,
    body: deepClone(body),
    headers: forwardedHeaders,
    upstreamUrl,
    capturedAt: now,
    lastRealRequestAt: now,
    lastPingAt: existing?.lastPingAt || 0,
    pingCount: existing?.pingCount || 0,
    errorCount: 0,
    lastCacheReadTokens: existing?.lastCacheReadTokens || 0,
    lastCacheCreationTokens: existing?.lastCacheCreationTokens || 0,
    lastStatus: existing?.lastStatus || null,
  });
}

/**
 * Start the keep-alive tick loop. No-op when disabled in config.
 */
export function start(config) {
  if (_started) return;
  _config = config?.proxy?.keepAlive ?? config;
  if (!_config?.enabled) {
    log.info('keep-alive disabled');
    return;
  }
  _started = true;
  _tickTimer = setInterval(() => {
    tick().catch(err => log.warn({ err: err.message }, 'tick error'));
  }, TICK_INTERVAL_MS);
  if (typeof _tickTimer.unref === 'function') _tickTimer.unref();
  log.info({
    intervalSeconds: _config.intervalSeconds,
    maxLifetimeMinutes: _config.maxLifetimeMinutes,
    onlyWithCacheControl: _config.onlyWithCacheControl,
  }, 'keep-alive started');
}

export function stop() {
  if (_tickTimer) {
    clearInterval(_tickTimer);
    _tickTimer = null;
  }
  _snapshots.clear();
  _started = false;
}

/**
 * Snapshot summary for /keepalive/status endpoint.
 */
export function getStatus() {
  const projects = [];
  for (const s of _snapshots.values()) {
    projects.push({
      projectId: s.projectId,
      lastRealRequestAt: s.lastRealRequestAt,
      lastPingAt: s.lastPingAt,
      pingCount: s.pingCount,
      lastCacheReadTokens: s.lastCacheReadTokens,
      lastCacheCreationTokens: s.lastCacheCreationTokens,
      lastStatus: s.lastStatus,
      errorCount: s.errorCount,
    });
  }
  return {
    enabled: !!_config?.enabled,
    started: _started,
    intervalSeconds: _config?.intervalSeconds ?? null,
    maxLifetimeMinutes: _config?.maxLifetimeMinutes ?? null,
    projects,
  };
}

// --- internals ---

async function tick() {
  if (!_started || !_config?.enabled) return;
  const now = Date.now();
  const intervalMs = (_config.intervalSeconds ?? 240) * 1000;
  const maxLifetimeMs = (_config.maxLifetimeMinutes ?? 30) * 60_000;

  for (const [projectId, snap] of _snapshots) {
    if (now - snap.lastRealRequestAt > maxLifetimeMs) {
      _snapshots.delete(projectId);
      log.info({ projectId, pingCount: snap.pingCount }, 'max lifetime reached, snapshot dropped');
      continue;
    }
    const lastTouch = Math.max(snap.lastRealRequestAt, snap.lastPingAt);
    if (now - lastTouch < intervalMs) continue;

    await sendPing(snap);
  }
}

async function sendPing(snap) {
  const pingBody = buildPingBody(snap.body);
  const started = Date.now();
  try {
    const res = await _httpClient({
      upstreamUrl: snap.upstreamUrl,
      headers: {
        ...snap.headers,
        'content-type': 'application/json',
      },
      body: JSON.stringify(pingBody),
    });
    const latencyMs = Date.now() - started;
    snap.lastPingAt = Date.now();
    snap.pingCount += 1;
    snap.lastStatus = res.statusCode;

    if (res.statusCode === 401 || res.statusCode === 403) {
      _snapshots.delete(snap.projectId);
      log.warn({
        projectId: snap.projectId,
        statusCode: res.statusCode,
        latencyMs,
      }, 'ping rejected, snapshot dropped');
      return;
    }

    if (res.statusCode >= 400) {
      snap.errorCount += 1;
      log.warn({
        projectId: snap.projectId,
        statusCode: res.statusCode,
        errorCount: snap.errorCount,
        latencyMs,
        body: typeof res.body === 'string' ? res.body.slice(0, 200) : null,
      }, 'ping non-success');
      if (snap.errorCount >= MAX_CONSECUTIVE_ERRORS) {
        _snapshots.delete(snap.projectId);
        log.warn({ projectId: snap.projectId }, 'max errors reached, snapshot dropped');
      }
      return;
    }

    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch { /* swallow */ }
    const usage = parsed?.usage || {};
    snap.lastCacheReadTokens = usage.cache_read_input_tokens || 0;
    snap.lastCacheCreationTokens = usage.cache_creation_input_tokens || 0;
    snap.errorCount = 0;

    log.info({
      projectId: snap.projectId,
      statusCode: res.statusCode,
      cacheReadTokens: snap.lastCacheReadTokens,
      cacheCreationTokens: snap.lastCacheCreationTokens,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      latencyMs,
      pingCount: snap.pingCount,
    }, 'ping ok');
  } catch (err) {
    snap.errorCount += 1;
    log.warn({
      projectId: snap.projectId,
      err: err.message,
      errorCount: snap.errorCount,
    }, 'ping network error');
    if (snap.errorCount >= MAX_CONSECUTIVE_ERRORS) {
      _snapshots.delete(snap.projectId);
      log.warn({ projectId: snap.projectId }, 'max errors reached, snapshot dropped');
    }
  }
}

function buildPingBody(originalBody) {
  const body = deepClone(originalBody);
  body.max_tokens = 1;
  body.stream = false;
  delete body.tool_choice;
  return body;
}

/**
 * Walk the request body looking for any cache_control marker. Anthropic
 * accepts cache_control on system blocks, tool definitions, and message
 * content blocks.
 */
function hasCacheControl(body) {
  if (Array.isArray(body.system)) {
    for (const block of body.system) if (block?.cache_control) return true;
  }
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) if (t?.cache_control) return true;
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (Array.isArray(m?.content)) {
        for (const c of m.content) if (c?.cache_control) return true;
      }
    }
  }
  return false;
}

function deepClone(obj) {
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

function defaultHttpClient({ upstreamUrl, headers, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(upstreamUrl);
    const path = (url.pathname.replace(/\/$/, '') || '') + '/v1/messages';
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      method: 'POST',
      path,
      headers: {
        ...headers,
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('keepalive ping timeout')));
    req.write(body);
    req.end();
  });
}

// --- test hooks ---

export function _test_setHttpClient(fn) {
  _httpClient = fn || defaultHttpClient;
}

export function _test_runTick() {
  return tick();
}

export function _test_getSnapshot(projectId) {
  return _snapshots.get(projectId);
}

export function _test_reset() {
  stop();
  _httpClient = defaultHttpClient;
}
