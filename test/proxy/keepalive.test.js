import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  captureSnapshot,
  start,
  stop,
  getStatus,
  _test_setHttpClient,
  _test_runTick,
  _test_getSnapshot,
  _test_reset,
} from '../../src/proxy/keepalive.js';

const baseConfig = {
  proxy: {
    keepAlive: {
      enabled: true,
      apiKeyOnly: true,
      intervalSeconds: 240,
      idleShutdownSeconds: 3600,
      maxLifetimeMinutes: 30,
      onlyWithCacheControl: true,
    },
  },
};

const cachedBody = {
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  stream: true,
  system: [
    { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
  ],
  messages: [
    { role: 'user', content: 'hi' },
  ],
};

const apiKeyHeaders = {
  'x-api-key': 'sk-ant-api03-test',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'context-1m-2025-08-07',
  'user-agent': 'Claude-Code/1.0',
  'host': 'should-be-stripped',
};

beforeEach(() => {
  _test_reset();
});

afterEach(() => {
  _test_reset();
  vi.useRealTimers();
});

describe('captureSnapshot', () => {
  it('rejects session-mode requests (PRD R1)', () => {
    start(baseConfig);
    captureSnapshot({
      projectId: 'proj-a',
      body: cachedBody,
      headers: { ...apiKeyHeaders, authorization: 'Bearer xyz' },
      upstreamUrl: 'https://api.anthropic.com',
      authMode: 'session',
    });
    expect(_test_getSnapshot('proj-a')).toBeUndefined();
  });

  it('rejects requests without cache_control when onlyWithCacheControl=true', () => {
    start(baseConfig);
    captureSnapshot({
      projectId: 'proj-a',
      body: { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      headers: apiKeyHeaders,
      upstreamUrl: 'https://api.anthropic.com',
      authMode: 'api_key',
    });
    expect(_test_getSnapshot('proj-a')).toBeUndefined();
  });

  it('accepts api_key requests with cache_control and stores forwarded headers only', () => {
    start(baseConfig);
    captureSnapshot({
      projectId: 'proj-a',
      body: cachedBody,
      headers: apiKeyHeaders,
      upstreamUrl: 'https://api.anthropic.com',
      authMode: 'api_key',
    });
    const snap = _test_getSnapshot('proj-a');
    expect(snap).toBeDefined();
    expect(snap.headers['x-api-key']).toBe('sk-ant-api03-test');
    expect(snap.headers['anthropic-beta']).toBe('context-1m-2025-08-07');
    expect(snap.headers['host']).toBeUndefined();
    expect(snap.body).not.toBe(cachedBody);
  });

  it('detects cache_control on tools and message content blocks', () => {
    start(baseConfig);
    const bodyToolsCache = {
      model: 'm', max_tokens: 5,
      tools: [{ name: 't', input_schema: {}, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    captureSnapshot({
      projectId: 'proj-tools',
      body: bodyToolsCache,
      headers: apiKeyHeaders,
      upstreamUrl: 'https://api.anthropic.com',
      authMode: 'api_key',
    });
    expect(_test_getSnapshot('proj-tools')).toBeDefined();

    const bodyMsgCache = {
      model: 'm', max_tokens: 5,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
      }],
    };
    captureSnapshot({
      projectId: 'proj-msg',
      body: bodyMsgCache,
      headers: apiKeyHeaders,
      upstreamUrl: 'https://api.anthropic.com',
      authMode: 'api_key',
    });
    expect(_test_getSnapshot('proj-msg')).toBeDefined();
  });
});

describe('tick + sendPing', () => {
  it('sends ping with max_tokens=1, stream=false, preserves cache_control headers/body', async () => {
    start(baseConfig);
    let received = null;
    _test_setHttpClient(async ({ upstreamUrl, headers, body }) => {
      received = { upstreamUrl, headers, body: JSON.parse(body) };
      return {
        statusCode: 200,
        body: JSON.stringify({
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            cache_read_input_tokens: 4096,
            cache_creation_input_tokens: 0,
          },
        }),
      };
    });

    captureSnapshot({
      projectId: 'proj-a',
      body: cachedBody,
      headers: apiKeyHeaders,
      upstreamUrl: 'https://api.anthropic.com',
      authMode: 'api_key',
    });
    const snap = _test_getSnapshot('proj-a');
    snap.lastRealRequestAt = Date.now() - 5 * 60_000;

    await _test_runTick();

    expect(received).not.toBeNull();
    expect(received.upstreamUrl).toBe('https://api.anthropic.com');
    expect(received.headers['x-api-key']).toBe('sk-ant-api03-test');
    expect(received.body.max_tokens).toBe(1);
    expect(received.body.stream).toBe(false);
    expect(received.body.system[0].cache_control).toEqual({ type: 'ephemeral' });

    expect(snap.pingCount).toBe(1);
    expect(snap.lastCacheReadTokens).toBe(4096);
    expect(snap.lastCacheCreationTokens).toBe(0);
    expect(snap.errorCount).toBe(0);
  });

  it('does not send ping when interval has not elapsed', async () => {
    start(baseConfig);
    const httpFn = vi.fn(async () => ({ statusCode: 200, body: '{}' }));
    _test_setHttpClient(httpFn);

    captureSnapshot({
      projectId: 'proj-a',
      body: cachedBody,
      headers: apiKeyHeaders,
      upstreamUrl: 'https://api.anthropic.com',
      authMode: 'api_key',
    });

    await _test_runTick();
    expect(httpFn).not.toHaveBeenCalled();
  });

  it('drops snapshot after maxLifetimeMinutes idle', async () => {
    start(baseConfig);
    const httpFn = vi.fn(async () => ({ statusCode: 200, body: '{}' }));
    _test_setHttpClient(httpFn);

    captureSnapshot({
      projectId: 'proj-a',
      body: cachedBody,
      headers: apiKeyHeaders,
      upstreamUrl: 'https://api.anthropic.com',
      authMode: 'api_key',
    });
    const snap = _test_getSnapshot('proj-a');
    snap.lastRealRequestAt = Date.now() - 31 * 60_000;

    await _test_runTick();

    expect(_test_getSnapshot('proj-a')).toBeUndefined();
    expect(httpFn).not.toHaveBeenCalled();
  });

  it('drops snapshot on 401', async () => {
    start(baseConfig);
    _test_setHttpClient(async () => ({
      statusCode: 401,
      body: '{"error":{"type":"authentication_error"}}',
    }));

    captureSnapshot({
      projectId: 'proj-a',
      body: cachedBody,
      headers: apiKeyHeaders,
      upstreamUrl: 'https://api.anthropic.com',
      authMode: 'api_key',
    });
    const snap = _test_getSnapshot('proj-a');
    snap.lastRealRequestAt = Date.now() - 5 * 60_000;

    await _test_runTick();

    expect(_test_getSnapshot('proj-a')).toBeUndefined();
  });

  it('drops snapshot after 3 consecutive 5xx errors', async () => {
    start(baseConfig);
    _test_setHttpClient(async () => ({ statusCode: 503, body: 'service unavailable' }));

    captureSnapshot({
      projectId: 'proj-a',
      body: cachedBody,
      headers: apiKeyHeaders,
      upstreamUrl: 'https://api.anthropic.com',
      authMode: 'api_key',
    });

    for (let i = 0; i < 3; i++) {
      const snap = _test_getSnapshot('proj-a');
      if (!snap) break;
      snap.lastPingAt = 0;
      snap.lastRealRequestAt = Date.now() - 5 * 60_000;
      await _test_runTick();
    }

    expect(_test_getSnapshot('proj-a')).toBeUndefined();
  });

  it('does not send ping when keepAlive disabled', async () => {
    const disabled = {
      proxy: { keepAlive: { ...baseConfig.proxy.keepAlive, enabled: false } },
    };
    start(disabled);
    const httpFn = vi.fn(async () => ({ statusCode: 200, body: '{}' }));
    _test_setHttpClient(httpFn);

    captureSnapshot({
      projectId: 'proj-a',
      body: cachedBody,
      headers: apiKeyHeaders,
      upstreamUrl: 'https://api.anthropic.com',
      authMode: 'api_key',
    });
    expect(_test_getSnapshot('proj-a')).toBeUndefined();
    await _test_runTick();
    expect(httpFn).not.toHaveBeenCalled();
  });
});

describe('getStatus', () => {
  it('reflects active project state', () => {
    start(baseConfig);
    captureSnapshot({
      projectId: 'proj-a',
      body: cachedBody,
      headers: apiKeyHeaders,
      upstreamUrl: 'https://api.anthropic.com',
      authMode: 'api_key',
    });
    const status = getStatus();
    expect(status.enabled).toBe(true);
    expect(status.started).toBe(true);
    expect(status.intervalSeconds).toBe(240);
    expect(status.projects).toHaveLength(1);
    expect(status.projects[0].projectId).toBe('proj-a');
  });

  it('returns disabled state after stop', () => {
    start(baseConfig);
    stop();
    const status = getStatus();
    expect(status.started).toBe(false);
    expect(status.projects).toHaveLength(0);
  });
});
