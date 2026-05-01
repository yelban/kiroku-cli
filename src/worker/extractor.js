import https from 'node:https';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { KIROKU_ROOT } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import { resolveAnthropicAuth, buildAuthHeaders } from './anthropic-auth.js';
import { createBatchStreamParser } from './batch-parser.js';

const log = createLogger('extractor');

// OAuth Max tokens require this exact identifier as the first system block;
// requests without it return HTTP 429 (anti-abuse, masquerading as rate limit).
const CLAUDE_CODE_IDENTIFIER = "You are Claude Code, Anthropic's official CLI for Claude.";

function buildAnthropicSystem(promptText, isOAuth) {
  const block = { type: 'text', text: promptText, cache_control: { type: 'ephemeral' } };
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
  const path = join(KIROKU_ROOT, 'prompts', 'extraction-batch.md');
  if (existsSync(path)) {
    _batchSystemPrompt = readFileSync(path, 'utf8');
  } else {
    log.warn({ path }, 'extraction-batch.md missing, falling back to single-turn prompt');
    _batchSystemPrompt = getSystemPrompt();
  }
  return _batchSystemPrompt;
}

export async function extractBatch(turns, extractionConfig) {
  const provider = extractionConfig.provider;
  if (provider !== 'anthropic') {
    throw new Error(`extractBatch only supports anthropic provider (got: ${provider})`);
  }
  return await extractBatchAnthropic(turns, extractionConfig);
}

async function extractBatchAnthropic(turns, config) {
  const auth = await resolveAnthropicAuth(config);

  const userMessage = turns.map((t, idx) =>
    `===TURN_${idx}===\n${t.text}\n===TURN_${idx}_END_INPUT===`
  ).join('\n\n');

  const requestBody = {
    model: config.model || 'claude-haiku-4-5-20251001',
    max_tokens: config.maxOutputTokens || 8000,
    stream: true,
    system: buildAnthropicSystem(getBatchSystemPrompt(), auth.isOAuth),
    messages: [{ role: 'user', content: userMessage }],
  };
  if (config.effort) {
    requestBody.output_config = { effort: config.effort };
  }
  const body = JSON.stringify(requestBody);

  const url = new URL(auth.baseUrl);
  const authHeaders = buildAuthHeaders(auth);
  const parser = createBatchStreamParser();

  await httpRequestStreaming({
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
  log.info({
    cache_creation: u.cache_creation_input_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    stop: result.stopReason,
    requested: turns.length,
    completed: result.completedTurns.length,
    errors: result.errors.length,
  }, 'batch extraction usage');
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
  const auth = await resolveAnthropicAuth(config);
  const requestBody = {
    model: config.model || 'claude-haiku-4-5-20251001',
    max_tokens: config.maxOutputTokens || 1200,
    system: buildAnthropicSystem(getSystemPrompt(), auth.isOAuth),
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
  const data = await httpRequest({
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
  }, body);

  const response = JSON.parse(data);
  const u = response.usage || {};
  if (u.cache_creation_input_tokens || u.cache_read_input_tokens) {
    log.info({
      cache_creation: u.cache_creation_input_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
    }, 'extraction usage');
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
    delete options.protocol;
    const req = mod.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        } else {
          resolve(data);
        }
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
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        });
        res.on('error', reject);
        return;
      }
      res.on('data', chunk => {
        try { onData(chunk); }
        catch (err) { req.destroy(err); }
      });
      res.on('end', () => resolve());
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('Streaming request timeout')));
    if (body) req.write(body);
    req.end();
  });
}
