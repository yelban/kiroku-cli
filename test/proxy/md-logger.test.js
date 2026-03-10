import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Redirect CONVERSATIONS_LOG_DIR to temp
const TEST_DIR = join(tmpdir(), 'kiroku-test-md-logger-' + Date.now());

vi.mock('../../src/shared/paths.js', () => ({
  CONVERSATIONS_LOG_DIR: TEST_DIR,
}));

const { logTurnToMarkdown } = await import('../../src/proxy/md-logger.js');

describe('logTurnToMarkdown', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  function makeEvent(overrides = {}) {
    return {
      project_id: 'test-proj',
      conversation_id: 'sess-12345678-abcd',
      captured_at: '2026-03-07T10:30:00Z',
      request: { model: 'claude-sonnet-4-20250514', user_text: 'Hello', tool_results: [] },
      response: { assistant_text: 'Hi there!', tool_uses: [] },
      ...overrides,
    };
  }

  it('should create a markdown file with header', () => {
    logTurnToMarkdown(makeEvent(), { maxToolInputLength: 5000, maxFileSizeKB: 512 });
    const projectDir = join(TEST_DIR, 'test-proj');
    const files = existsSync(projectDir) ? require('node:fs').readdirSync(projectDir) : [];
    expect(files.length).toBeGreaterThan(0);
    const content = readFileSync(join(projectDir, files[0]), 'utf8');
    expect(content).toContain('# Conversation Log');
    expect(content).toContain('**Project:** test-proj');
    expect(content).toContain('**Model:** claude-sonnet-4-20250514');
  });

  it('should include user and assistant text', () => {
    logTurnToMarkdown(makeEvent(), { maxToolInputLength: 5000, maxFileSizeKB: 512 });
    const projectDir = join(TEST_DIR, 'test-proj');
    const files = require('node:fs').readdirSync(projectDir);
    const content = readFileSync(join(projectDir, files[0]), 'utf8');
    expect(content).toContain('**User:**');
    expect(content).toContain('Hello');
    expect(content).toContain('**Assistant:**');
    expect(content).toContain('Hi there!');
  });

  it('should include turn number and time', () => {
    logTurnToMarkdown(makeEvent(), { maxToolInputLength: 5000, maxFileSizeKB: 512 });
    const projectDir = join(TEST_DIR, 'test-proj');
    const files = require('node:fs').readdirSync(projectDir);
    const content = readFileSync(join(projectDir, files[0]), 'utf8');
    expect(content).toContain('### Turn');
    expect(content).toContain('10:30:00');
  });

  it('should handle tool uses in response', () => {
    const event = makeEvent({
      response: {
        assistant_text: 'Let me read that.',
        tool_uses: [{ name: 'Read', input: { file: 'test.js' } }],
      },
    });
    logTurnToMarkdown(event, { maxToolInputLength: 5000, maxFileSizeKB: 512 });
    const projectDir = join(TEST_DIR, 'test-proj');
    const files = require('node:fs').readdirSync(projectDir);
    const content = readFileSync(join(projectDir, files[0]), 'utf8');
    expect(content).toContain('#### Tool Use: `Read`');
  });
});
