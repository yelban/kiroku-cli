import https from 'node:https';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { KIROKU_ROOT } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import { resolveAnthropicAuth, buildAuthHeaders, reconcileOauthToken } from './anthropic-auth.js';
import { createBatchStreamParser } from './batch-parser.js';
import { recordUsage as recordCacheUsage, shouldUseCacheControl, getCacheHealth } from './cache-health.js';
import { parseRatelimit, deriveRetryAfterMs } from './ratelimit.js';
import EMBEDDED_BATCH_PROMPT from '../../prompts/extraction-batch.md';

const log = createLogger('extractor');

// OAuth Max tokens require this exact identifier as the first system block;
// requests without it return HTTP 429 (anti-abuse, masquerading as rate limit).
const CLAUDE_CODE_IDENTIFIER = "You are Claude Code, Anthropic's official CLI for Claude.";

function buildAnthropicSystem(promptText, isOAuth, useCacheControl = true) {
  const block = useCacheControl
    ? { type: 'text', text: promptText, cache_control: { type: 'ephemeral' } }
    : { type: 'text', text: promptText };
  if (isOAuth) {
    return [{ type: 'text', text: CLAUDE_CODE_IDENTIFIER }, block];
  }
  return [block];
}

let _systemPrompt = null;
let _batchSystemPrompt = null;
let _getPromptOverride = null;

// Allow prompt-loader to inject premium prompt
export function setPromptProvider(fn) {
  _getPromptOverride = fn;
  _systemPrompt = null; // clear cache
}

function getSystemPrompt() {
  if (_getPromptOverride) {
    const override = _getPromptOverride();
    if (override) return override;
  }
  if (_systemPrompt) return _systemPrompt;
  // Try premium prompt first, then basic
  const premiumPath = join(KIROKU_ROOT, 'prompts', 'extraction.md');
  const basicPath = join(KIROKU_ROOT, 'prompts', 'extraction-basic.md');
  if (existsSync(premiumPath)) {
    _systemPrompt = readFileSync(premiumPath, 'utf8');
  } else {
    _systemPrompt = readFileSync(basicPath, 'utf8');
  }
  return _systemPrompt;
}

function getBatchSystemPrompt() {
  if (_batchSystemPrompt) return _batchSystemPrompt;
  // Dev path: prefer fs read so prompts/extraction-batch.md edits live-reload after `npm run build`.
  // Production (npm-installed) bundles do not ship prompts/, so fall back to the embedded copy.
  const path = join(KIROKU_ROOT, 'prompts', 'extraction-batch.md');
  if (existsSync(path)) {
    _batchSystemPrompt = readFileSync(path, 'utf8');
  } else {
    _batchSystemPrompt = EMBEDDED_BATCH_PROMPT;
  }
  return _batchSystemPrompt;
}

// Providers supported by the batch streaming pipeline. Caller (worker.js)
// uses the same set to decide whether processFile routes through bufferEvent.
export const BATCH_PROVIDERS = new Set(['anthropic', 'openrouter', 'openai-compatible']);

export async function extractBatch(turns, extractionConfig) {
  const provider = extractionConfig.provider;
  if (provider === 'anthropic') {
    return await extractBatchAnthropic(turns, extractionConfig);
  }
  if (provider === 'openrouter' || provider === 'openai-compatible') {
    const apiKey = process.env[extractionConfig.apiKeyEnv || 'OPENROUTER_API_KEY']
      || process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error(`extractBatch ${provider}: missing API key in env`);
    const baseUrl = provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : (extractionConfig.baseUrl || 'https://api.openai.com/v1');
    return await extractBatchOpenAICompatible(turns, extractionConfig, apiKey, baseUrl);
  }
  throw new Error(`extractBatch does not support provider: ${provider}`);
}

async function extractBatchAnthropic(turns, config) {
  return await withOauth401Retry(() => withEffortFallback((cfg) => extractBatchAnthropicOnce(turns, cfg), config));
}

// Some Anthropic models (e.g. Haiku 4.5) reject the output_config.effort
// parameter with HTTP 400. On that specific error, retry once without
// effort. Other errors propagate.
async function withEffortFallback(fn, config) {
  try {
    return await fn(config);
  } catch (err) {
    const msg = err?.message || '';
    if (config?.effort && /does not support the effort parameter/.test(msg)) {
      log.info({ model: config.model }, 'model rejects effort parameter — retrying without it');
      const fallback = { ...config, effort: null };
      return await fn(fallback);
    }
    throw err;
  }
}

// Wrap an anthropic call: on HTTP 401, run reconcileOauthToken() once and
// retry. Covers the case where Claude Code rotated its OAuth token mid-session
// after the worker had already cached the old one.
async function withOauth401Retry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (typeof err?.message === 'string' && err.message.startsWith('HTTP 401') && reconcileOauthToken()) {
      log.info('HTTP 401 → reconciled OAuth token, retrying once');
      return await fn();
    }
    throw err;
  }
}

async function extractBatchAnthropicOnce(turns, config) {
  const auth = await resolveAnthropicAuth(config);

  const userMessage = turns.map((t, idx) =>
    `===TURN_${idx}===\n${t.text}\n===TURN_${idx}_END_INPUT===`
  ).join('\n\n');

  const model = config.model || 'claude-haiku-4-5-20251001';
  const useCache = shouldUseCacheControl(model);
  const requestBody = {
    model,
    max_tokens: config.maxOutputTokens || 8000,
    stream: true,
    system: buildAnthropicSystem(getBatchSystemPrompt(), auth.isOAuth, useCache),
    messages: [{ role: 'user', content: userMessage }],
  };
  if (config.effort) {
    requestBody.output_config = { effort: config.effort };
  }
  const body = JSON.stringify(requestBody);

  const url = new URL(auth.baseUrl);
  const authHeaders = buildAuthHeaders(auth);
  const parser = createBatchStreamParser();

  const httpResult = await httpRequestStreaming({
    hostname: url.hostname,
    port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
    path: (url.pathname.includes('/v1') ? url.pathname.replace(/\/$/, '') : url.pathname.replace(/\/$/, '') + '/v1') + '/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...authHeaders,
      'Content-Length': Buffer.byteLength(body),
    },
    protocol: url.protocol.replace(':', ''),
    onData: chunk => parser.feed(chunk),
  }, body);

  const result = parser.finalize();
  const u = result.usage || {};
  recordCacheUsage(model, u);
  const health = getCacheHealth(model);
  const ratelimit = parseRatelimit(httpResult?.headers);
  log.info({
    cache_creation: u.cache_creation_input_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    stop: result.stopReason,
    requested: turns.length,
    completed: result.completedTurns.length,
    errors: result.errors.length,
    cache_status: health?.status,
    cache_disabled: !useCache,
    ratelimit,
  }, 'batch extraction usage');
  if (health?.status === 'broken' && useCache) {
    log.warn({ model, creations: health.creations, reads: health.reads }, 'prompt cache appears broken on this model — disabling cache_control for subsequent calls (24h cooldown)');
  }
  return result;
}

// OpenAI-compatible (incl. OpenRouter) batch streaming. SSE shape:
//   data: {"choices":[{"delta":{"content":"..."}}]}
//   data: [DONE]
// We accumulate every delta.content into the BatchStreamParser via feedRaw,
// which then handles ===TURN_N_END=== detection just like the Anthropic path.
//
// Reasoning-only models (e.g. qwen3.6-35b-a3b) keep emitting empty content
// and stash text under delta.reasoning — those will produce 0 completed
// turns. mode api preset already steers users away from those.
async function extractBatchOpenAICompatible(turns, config, apiKey, baseUrl) {
  const userMessage = turns.map((t, idx) =>
    `===TURN_${idx}===\n${t.text}\n===TURN_${idx}_END_INPUT===`
  ).join('\n\n');

  const requestBody = {
    model: config.model,
    temperature: config.temperature ?? 0,
    max_tokens: config.maxOutputTokens || 8000,
    stream: true,
    messages: [
      { role: 'system', content: getBatchSystemPrompt() },
      { role: 'user', content: userMessage },
    ],
  };
  const body = JSON.stringify(requestBody);

  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/$/, '') + '/chat/completions';

  const parser = createBatchStreamParser();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let usage = null;

  const httpResult = await httpRequestStreaming({
    hostname: url.hostname,
    port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
    path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    },
    protocol: url.protocol.replace(':', ''),
    onData: chunk => {
      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) parser.feedRaw(delta);
          if (parsed.usage) usage = parsed.usage;
        } catch { /* skip malformed */ }
      }
    },
  }, body);

  // OpenAI-compatible shape: {prompt_tokens, completion_tokens, total_tokens}
  const result = parser.finalize();
  log.info({
    input: usage?.prompt_tokens || 0,
    output: usage?.completion_tokens || 0,
    requested: turns.length,
    completed: result.completedTurns.length,
    errors: result.errors.length,
    stop: result.stopReason,
    provider: baseUrl.includes('openrouter') ? 'openrouter' : 'openai-compatible',
  }, 'batch extraction usage');

  // OpenAI-compatible providers report rate limits in HTTP headers
  // (x-ratelimit-* on OpenAI, openrouter-specific headers on OR), but
  // the format isn't unified, so we skip the parseRatelimit step.
  void httpResult;
  return result;
}

export async function extract(text, extractionConfig) {
  const provider = extractionConfig.provider;
  const apiKey = process.env[extractionConfig.apiKeyEnv];

  if (provider === 'openrouter' && apiKey) {
    return await callOpenAICompatible(text, { ...extractionConfig, baseUrl: 'https://openrouter.ai/api/v1' }, apiKey);
  }

  if (provider === 'openai-compatible' && apiKey) {
    return await callOpenAICompatible(text, extractionConfig, apiKey);
  }

  if (provider === 'gemini' && apiKey) {
    return await callGemini(text, extractionConfig, apiKey);
  }

  if (provider === 'anthropic') {
    return await callAnthropic(text, extractionConfig);
  }

  if (provider === 'ollama' || !apiKey) {
    const fallback = extractionConfig.fallback || extractionConfig;
    return await callOllama(text, fallback);
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

async function callOpenAICompatible(text, config, apiKey) {
  const url = new URL(config.baseUrl || 'https://openrouter.ai/api/v1');
  const body = JSON.stringify({
    model: config.model,
    temperature: config.temperature,
    max_tokens: config.maxOutputTokens,
    messages: [
      { role: 'system', content: getSystemPrompt() },
      { role: 'user', content: `Extract knowledge from the following conversation turn:\n\n${text}` },
    ],
  });
  const path = url.pathname.replace(/\/$/, '') + '/chat/completions';

  const data = await httpRequest({
    hostname: url.hostname,
    port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
    path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(body),
    },
    protocol: url.protocol.replace(':', ''),
  }, body);

  const response = JSON.parse(data);
  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty extraction response');

  return parseExtractionResult(content);
}

async function callGemini(text, config, apiKey) {
  const model = config.model || 'gemini-2.0-flash';
  const body = JSON.stringify({
    contents: [
      { role: 'user', parts: [{ text: `Extract knowledge from the following conversation turn:\n\n${text}` }] },
    ],
    systemInstruction: { parts: [{ text: getSystemPrompt() }] },
    generationConfig: {
      temperature: config.temperature || 0,
      maxOutputTokens: config.maxOutputTokens || 1200,
    },
  });

  const data = await httpRequest({
    hostname: 'generativelanguage.googleapis.com',
    port: 443,
    path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    protocol: 'https',
  }, body);

  const response = JSON.parse(data);
  const content = response.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Empty Gemini response');

  return parseExtractionResult(content);
}

async function callAnthropic(text, config) {
  return await withOauth401Retry(() => withEffortFallback((cfg) => callAnthropicOnce(text, cfg), config));
}

async function callAnthropicOnce(text, config) {
  const auth = await resolveAnthropicAuth(config);
  const model = config.model || 'claude-haiku-4-5-20251001';
  const useCache = shouldUseCacheControl(model);
  const requestBody = {
    model,
    max_tokens: config.maxOutputTokens || 1200,
    system: buildAnthropicSystem(getSystemPrompt(), auth.isOAuth, useCache),
    messages: [
      { role: 'user', content: `Extract knowledge from the following conversation turn:\n\n${text}` },
    ],
  };
  if (config.effort) {
    requestBody.output_config = { effort: config.effort };
  }
  const body = JSON.stringify(requestBody);

  const url = new URL(auth.baseUrl);
  const authHeaders = buildAuthHeaders(auth);
  const { data, headers: respHeaders } = await httpRequest({
    hostname: url.hostname,
    port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
    path: (url.pathname.includes('/v1') ? url.pathname.replace(/\/$/, '') : url.pathname.replace(/\/$/, '') + '/v1') + '/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      'Content-Length': Buffer.byteLength(body),
    },
    protocol: url.protocol.replace(':', ''),
    withHeaders: true,
  }, body);

  const response = JSON.parse(data);
  const u = response.usage || {};
  recordCacheUsage(model, u);
  const health = getCacheHealth(model);
  const ratelimit = parseRatelimit(respHeaders);
  if (useCache || u.cache_creation_input_tokens || u.cache_read_input_tokens || ratelimit) {
    log.info({
      cache_creation: u.cache_creation_input_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cache_status: health?.status,
      cache_disabled: !useCache,
      ratelimit,
    }, 'extraction usage');
  }
  if (health?.status === 'broken' && useCache) {
    log.warn({ model, creations: health.creations, reads: health.reads }, 'prompt cache appears broken on this model — disabling cache_control for subsequent calls (24h cooldown)');
  }
  const content = response.content?.[0]?.text;
  if (!content) throw new Error('Empty Anthropic response');

  return parseExtractionResult(content);
}

async function callOllama(text, config) {
  const baseUrl = new URL(config.baseUrl || 'http://127.0.0.1:11434');
  const body = JSON.stringify({
    model: config.model,
    stream: false,
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: getSystemPrompt() },
      { role: 'user', content: `Extract knowledge from the following conversation turn:\n\n${text}` },
    ],
  });

  const data = await httpRequest({
    hostname: baseUrl.hostname,
    port: parseInt(baseUrl.port) || 11434,
    path: '/api/chat',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    protocol: baseUrl.protocol.replace(':', ''),
  }, body);

  const response = JSON.parse(data);
  const content = response.message?.content;
  if (!content) throw new Error('Empty Ollama response');

  return parseExtractionResult(content);
}

function parseExtractionResult(content) {
  // Try to extract JSON from the response (may be wrapped in markdown code blocks)
  let jsonStr = content;
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  }

  try {
    const result = JSON.parse(jsonStr.trim());
    return {
      entities: Array.isArray(result.entities) ? result.entities : [],
      facts: Array.isArray(result.facts) ? result.facts : [],
    };
  } catch {
    // Fallback: try to find JSON object in the text
    const jsonMatch = content.match(/\{[\s\S]*"entities"[\s\S]*"facts"[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        entities: Array.isArray(result.entities) ? result.entities : [],
        facts: Array.isArray(result.facts) ? result.facts : [],
      };
    }
    log.warn('failed to parse extraction result, returning empty');
    return { entities: [], facts: [] };
  }
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const mod = options.protocol === 'https' ? https : http;
    const opts = { ...options };
    delete opts.protocol;
    const wantHeaders = !!opts.withHeaders;
    delete opts.withHeaders;
    const req = mod.request(opts, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`);
          err.statusCode = res.statusCode;
          err.headers = res.headers;
          err.retryAfterMs = deriveRetryAfterMs(res.headers);
          reject(err);
          return;
        }
        if (wantHeaders) resolve({ data, headers: res.headers, statusCode: res.statusCode });
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function httpRequestStreaming(options, body) {
  return new Promise((resolve, reject) => {
    const mod = options.protocol === 'https' ? https : http;
    const opts = { ...options };
    delete opts.protocol;
    const onData = options.onData;
    delete opts.onData;
    if (typeof onData !== 'function') {
      reject(new Error('httpRequestStreaming requires options.onData'));
      return;
    }
    const req = mod.request(opts, res => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          const err = new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`);
          err.statusCode = res.statusCode;
          err.headers = res.headers;
          err.retryAfterMs = deriveRetryAfterMs(res.headers);
          reject(err);
        });
        res.on('error', reject);
        return;
      }
      res.on('data', chunk => {
        try { onData(chunk); }
        catch (err) { req.destroy(err); }
      });
      res.on('end', () => resolve({ headers: res.headers, statusCode: res.statusCode }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('Streaming request timeout')));
    if (body) req.write(body);
    req.end();
  });
}
