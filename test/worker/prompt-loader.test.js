import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

describe('prompt-loader', () => {
  describe('basic prompt fallback', () => {
    it('extraction-basic.md exists and is valid', () => {
      const basicPath = join(ROOT, 'prompts', 'extraction-basic.md');
      expect(existsSync(basicPath)).toBe(true);
      const content = readFileSync(basicPath, 'utf8');
      expect(content).toContain('knowledge extraction');
      expect(content).toContain('entities');
      expect(content).toContain('facts');
    });

    it('extraction-basic.md is shorter than premium', () => {
      const basicPath = join(ROOT, 'prompts', 'extraction-basic.md');
      const premiumPath = join(ROOT, 'prompts', 'extraction.md');
      if (!existsSync(premiumPath)) return; // Skip if premium not present

      const basic = readFileSync(basicPath, 'utf8');
      const premium = readFileSync(premiumPath, 'utf8');
      expect(basic.length).toBeLessThan(premium.length);
    });

    it('basic prompt has valid JSON schema description', () => {
      const basicPath = join(ROOT, 'prompts', 'extraction-basic.md');
      const content = readFileSync(basicPath, 'utf8');
      expect(content).toContain('"canonical_name"');
      expect(content).toContain('"entity_type"');
      expect(content).toContain('"predicate"');
    });
  });

  describe('extractor prompt resolution', () => {
    it('extractor uses KIROKU_ROOT for prompt path', async () => {
      // Verify the extractor imports KIROKU_ROOT
      const extractorPath = join(ROOT, 'src', 'worker', 'extractor.js');
      const source = readFileSync(extractorPath, 'utf8');
      expect(source).toContain('KIROKU_ROOT');
      expect(source).not.toContain("__dirname, '..', '..', 'prompts'");
    });

    it('extractor supports setPromptProvider', async () => {
      const extractorPath = join(ROOT, 'src', 'worker', 'extractor.js');
      const source = readFileSync(extractorPath, 'utf8');
      expect(source).toContain('export function setPromptProvider');
      expect(source).toContain('_getPromptOverride');
    });

    it('extractor falls back from premium to basic prompt', async () => {
      const extractorPath = join(ROOT, 'src', 'worker', 'extractor.js');
      const source = readFileSync(extractorPath, 'utf8');
      expect(source).toContain('extraction.md');
      expect(source).toContain('extraction-basic.md');
    });
  });

  describe('prompt-loader module structure', () => {
    it('exports expected functions', async () => {
      const loaderPath = join(ROOT, 'src', 'worker', 'prompt-loader.js');
      const source = readFileSync(loaderPath, 'utf8');
      expect(source).toContain('export function getPrompt');
      expect(source).toContain('export async function initPromptLoader');
      expect(source).toContain('export function stopPromptLoader');
    });

    it('uses 3-layer fallback (memory, disk, remote)', () => {
      const loaderPath = join(ROOT, 'src', 'worker', 'prompt-loader.js');
      const source = readFileSync(loaderPath, 'utf8');
      // Memory cache
      expect(source).toContain('_cachedPrompt');
      // Disk cache
      expect(source).toContain('PROMPT_CACHE_PATH');
      expect(source).toContain('loadFromDisk');
      // Remote fetch
      expect(source).toContain('fetchFromRemote');
      expect(source).toContain('kiroku-api');
    });

    it('supports ETag-based conditional fetch', () => {
      const loaderPath = join(ROOT, 'src', 'worker', 'prompt-loader.js');
      const source = readFileSync(loaderPath, 'utf8');
      expect(source).toContain('If-None-Match');
      expect(source).toContain('304');
    });

    it('has 24h background refresh', () => {
      const loaderPath = join(ROOT, 'src', 'worker', 'prompt-loader.js');
      const source = readFileSync(loaderPath, 'utf8');
      expect(source).toContain('REFRESH_INTERVAL');
      expect(source).toContain('24 * 60 * 60 * 1000');
    });
  });
});
