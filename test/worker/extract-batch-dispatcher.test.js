// Pure dispatcher tests for extractBatch — no actual HTTP traffic.
// Covers the env-var validation + provider routing layer.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractBatch, BATCH_PROVIDERS } from '../../src/worker/extractor.js';

const SAVED = {};
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN',
                  'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] != null) process.env[k] = SAVED[k];
    else delete process.env[k];
  }
});

describe('extractBatch dispatcher', () => {
  it('exports BATCH_PROVIDERS set covering anthropic, openrouter, openai-compatible, gemini', () => {
    expect(BATCH_PROVIDERS.has('anthropic')).toBe(true);
    expect(BATCH_PROVIDERS.has('openrouter')).toBe(true);
    expect(BATCH_PROVIDERS.has('openai-compatible')).toBe(true);
    expect(BATCH_PROVIDERS.has('gemini')).toBe(true);
    expect(BATCH_PROVIDERS.has('ollama')).toBe(false);
  });

  it('throws on unknown provider', async () => {
    await expect(
      extractBatch([{ text: 'hello' }], { provider: 'made-up' })
    ).rejects.toThrow(/does not support provider: made-up/);
  });

  it('throws on openrouter without API key', async () => {
    await expect(
      extractBatch([{ text: 'hi' }], { provider: 'openrouter' })
    ).rejects.toThrow(/missing API key/);
  });

  it('throws on openai-compatible without API key', async () => {
    await expect(
      extractBatch([{ text: 'hi' }], { provider: 'openai-compatible', apiKeyEnv: 'OPENAI_API_KEY' })
    ).rejects.toThrow(/missing API key/);
  });

  it('throws on gemini without GEMINI_API_KEY', async () => {
    await expect(
      extractBatch([{ text: 'hi' }], { provider: 'gemini' })
    ).rejects.toThrow(/missing GEMINI_API_KEY/);
  });

  it('honors apiKeyEnv override for gemini', async () => {
    process.env.MY_CUSTOM_GEMINI_KEY = 'fake-key';
    // We expect this to not throw the 'missing key' error;
    // it'll fail later trying to actually hit the network, which is fine.
    try {
      await extractBatch([{ text: 'hi' }], { provider: 'gemini', apiKeyEnv: 'MY_CUSTOM_GEMINI_KEY' });
    } catch (err) {
      expect(err.message).not.toMatch(/missing GEMINI_API_KEY/);
    }
    delete process.env.MY_CUSTOM_GEMINI_KEY;
  });
});
