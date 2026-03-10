import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'kiroku-test-transcript-' + Date.now());
const PROJECTS_DIR = join(TEST_DIR, 'projects');
const TRANSCRIPTS_DIR = join(TEST_DIR, 'transcripts');

vi.mock('../../src/shared/paths.js', () => ({
  CLAUDE_PROJECTS_DIR: PROJECTS_DIR,
  TRANSCRIPTS_DIR: TRANSCRIPTS_DIR,
}));

vi.mock('../../src/shared/config.js', () => ({
  loadConfig: () => ({
    proxy: {
      dlp: {
        enabled: true,
        rules: {
          awsAccessKey: true,
          anthropicApiKey: true,
          openaiApiKey: true,
          githubPat: true,
          slackToken: true,
        },
      },
    },
  }),
}));

const { listSessions, convertTranscript } = await import('../../src/cli/transcript-converter.js');

describe('transcript-converter', () => {
  beforeEach(() => {
    mkdirSync(PROJECTS_DIR, { recursive: true });
    mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  describe('listSessions', () => {
    it('should return empty array for nonexistent dir', () => {
      expect(listSessions('/nonexistent')).toEqual([]);
    });

    it('should list .jsonl files', () => {
      const dir = join(TEST_DIR, 'list-test');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'abc-123.jsonl'), '{"timestamp":"2026-01-01T00:00:00Z"}\n');
      writeFileSync(join(dir, 'def-456.jsonl'), '{"timestamp":"2026-01-02T00:00:00Z"}\n');
      const sessions = listSessions(dir);
      expect(sessions).toHaveLength(2);
      expect(sessions[0].sessionId).toBeDefined();
    });
  });

  describe('convertTranscript', () => {
    it('should convert JSONL to markdown', () => {
      const sessionFile = join(TEST_DIR, 'test-session.jsonl');
      const lines = [
        JSON.stringify({ type: 'user', sessionId: 'test-session', timestamp: '2026-03-07T10:00:00Z', message: { content: 'Hello' } }),
        JSON.stringify({ type: 'assistant', sessionId: 'test-session', timestamp: '2026-03-07T10:00:01Z', message: { content: [{ type: 'text', text: 'Hi!' }] } }),
      ];
      writeFileSync(sessionFile, lines.join('\n'));

      const result = convertTranscript(sessionFile, { output: join(TEST_DIR, 'out.md') });
      expect(result.turnCount).toBe(1);
      const md = readFileSync(result.outputPath, 'utf8');
      expect(md).toContain('# Conversation Transcript');
      expect(md).toContain('Hello');
      expect(md).toContain('Hi!');
    });

    it('should filter sidechain entries', () => {
      const sessionFile = join(TEST_DIR, 'sidechain-test.jsonl');
      // sessionId must match filename (basename without .jsonl)
      const sid = 'sidechain-test';
      const lines = [
        JSON.stringify({ type: 'user', sessionId: sid, timestamp: '2026-01-01T00:00:00Z', message: { content: 'main' } }),
        JSON.stringify({ type: 'assistant', sessionId: sid, timestamp: '2026-01-01T00:00:01Z', isSidechain: true, message: { content: [{ type: 'text', text: 'side' }] } }),
        JSON.stringify({ type: 'assistant', sessionId: sid, timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'text', text: 'real' }] } }),
      ];
      writeFileSync(sessionFile, lines.join('\n'));

      const result = convertTranscript(sessionFile, { output: join(TEST_DIR, 'side-out.md') });
      const md = readFileSync(result.outputPath, 'utf8');
      // "side" appears in session ID header, but sidechain assistant text should be filtered
      expect(md).toContain('real');
      // Verify there is only 1 Assistant block (the non-sidechain one)
      const assistantBlocks = md.match(/\*\*Assistant:\*\*/g) || [];
      expect(assistantBlocks).toHaveLength(1);
    });

    it('should filter entries from other sessions', () => {
      const sessionFile = join(TEST_DIR, 'multi-session.jsonl');
      const sid = 'multi-session';
      const lines = [
        JSON.stringify({ type: 'user', sessionId: sid, timestamp: '2026-01-01T00:00:00Z', message: { content: 'mine' } }),
        JSON.stringify({ type: 'user', sessionId: 'other-session', timestamp: '2026-01-01T00:00:01Z', message: { content: 'theirs' } }),
        JSON.stringify({ type: 'assistant', sessionId: sid, timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'text', text: 'reply' }] } }),
      ];
      writeFileSync(sessionFile, lines.join('\n'));

      const result = convertTranscript(sessionFile, { output: join(TEST_DIR, 'multi-out.md') });
      const md = readFileSync(result.outputPath, 'utf8');
      expect(md).toContain('mine');
      expect(md).not.toContain('theirs');
    });

    it('should handle unparseable lines gracefully', () => {
      const sessionFile = join(TEST_DIR, 'bad-lines.jsonl');
      const lines = [
        '{bad json',
        JSON.stringify({ type: 'user', sessionId: 'bad-lines', timestamp: '2026-01-01T00:00:00Z', message: { content: 'ok' } }),
        JSON.stringify({ type: 'assistant', sessionId: 'bad-lines', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'text', text: 'fine' }] } }),
      ];
      writeFileSync(sessionFile, lines.join('\n'));

      const result = convertTranscript(sessionFile, { output: join(TEST_DIR, 'bad-out.md') });
      expect(result.turnCount).toBe(1);
    });
  });
});
