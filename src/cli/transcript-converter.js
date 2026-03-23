/**
 * Converts Claude Code native transcript (.jsonl) to readable markdown.
 * Defensive parsing: unknown formats are skipped, not crashed.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { CLAUDE_PROJECTS_DIR, TRANSCRIPTS_DIR } from '../shared/paths.js';
import { formatToolUseBlock, formatToolResultBlock, formatThinkingBlock } from '../shared/md-format.js';
import { redact } from '../shared/redact.js';

const DEFAULT_MAX_RESULT_LEN = 5000;

/**
 * List available sessions for the current project.
 */
export function listSessions(projectDir) {
  if (!projectDir) {
    projectDir = resolveProjectDir();
  }
  if (!projectDir || !existsSync(projectDir)) {
    return [];
  }
  const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
  return files.map(f => {
    const sessionId = f.replace('.jsonl', '');
    const filePath = join(projectDir, f);
    let firstTimestamp = null;
    let lastTimestamp = null;
    let lineCount = 0;
    try {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      lineCount = lines.length;
      // Get timestamps from first and last meaningful entries
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.timestamp) {
            if (!firstTimestamp) firstTimestamp = obj.timestamp;
            lastTimestamp = obj.timestamp;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return { sessionId, filePath, firstTimestamp, lastTimestamp, lineCount };
  }).sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));
}

/**
 * Convert a session JSONL to markdown.
 * @param {string} sessionIdOrPath - Session ID (UUID) or full file path
 * @param {object} opts
 * @param {boolean} opts.thinking - Include thinking blocks
 * @param {boolean} opts.noRedact - Skip DLP redaction
 * @param {string} opts.output - Output file path
 * @param {number} opts.maxResultLen - Max chars for tool results
 */
export function convertTranscript(sessionIdOrPath, opts = {}) {
  const { thinking = false, noRedact = false, output, maxResultLen = DEFAULT_MAX_RESULT_LEN } = opts;

  // Resolve input path
  let inputPath;
  if (existsSync(sessionIdOrPath)) {
    inputPath = sessionIdOrPath;
  } else {
    const projectDir = resolveProjectDir();
    if (!projectDir) throw new Error('Cannot resolve project directory. Provide full path.');
    inputPath = join(projectDir, `${sessionIdOrPath}.jsonl`);
    if (!existsSync(inputPath)) {
      throw new Error(`Session not found: ${sessionIdOrPath}`);
    }
  }

  // Parse JSONL
  const content = readFileSync(inputPath, 'utf8');
  const rawLines = content.split('\n').filter(l => l.trim());
  const entries = [];
  for (const line of rawLines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip unparseable lines
    }
  }

  // Derive session ID from filename
  const fileSessionId = basename(inputPath, '.jsonl');

  // Filter out noise and entries from other sessions
  const meaningful = entries.filter(e => {
    if (e.isSidechain) return false;
    if (e.isMeta) return false;
    if (e.type === 'progress') return false;
    if (e.type === 'file-history-snapshot') return false;
    if (e.type === 'system') return false;
    if (e.sessionId && e.sessionId !== fileSessionId) return false;
    if (e.type === 'user' || e.type === 'assistant') return true;
    return false;
  });
  const meta = entries.find(e => e.sessionId === fileSessionId)
    || entries.find(e => e.sessionId)
    || {};

  // Group into turns: a turn starts with a user message
  const turns = [];
  let currentTurn = null;
  for (const entry of meaningful) {
    if (entry.type === 'user') {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { user: entry, assistants: [] };
    } else if (entry.type === 'assistant' && currentTurn) {
      currentTurn.assistants.push(entry);
    }
  }
  if (currentTurn) turns.push(currentTurn);

  // Build markdown
  const md = [];
  md.push('# Conversation Transcript');
  md.push('');
  if (meta.sessionId) md.push(`- **Session:** ${meta.sessionId}`);
  if (meta.cwd) md.push(`- **CWD:** ${meta.cwd}`);
  if (meta.gitBranch) md.push(`- **Branch:** ${meta.gitBranch}`);
  if (meta.version) md.push(`- **Claude Code:** v${meta.version}`);
  const firstTs = meaningful[0]?.timestamp;
  if (firstTs) md.push(`- **Date:** ${firstTs.slice(0, 10)}`);
  md.push('');
  md.push('---');
  md.push('');

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const ts = turn.user.timestamp ? turn.user.timestamp.slice(11, 19) : '';
    md.push(`## Turn ${i + 1}${ts ? ` — ${ts}` : ''}`);
    md.push('');

    // User message
    const userContent = turn.user.message?.content;
    if (userContent) {
      const { text: userText, toolResultBlocks } = extractUserContent(userContent);
      if (userText) {
        const displayText = noRedact ? userText : redact(userText).text;
        md.push('**User:**');
        md.push('');
        md.push(displayText);
        md.push('');
      }
      if (toolResultBlocks.length > 0) {
        for (const tr of toolResultBlocks) {
          md.push(formatToolResultBlock(tr.content, maxResultLen));
        }
      }
    }

    // Assistant messages
    for (const asst of turn.assistants) {
      const blocks = asst.message?.content;
      if (!Array.isArray(blocks)) continue;

      for (const block of blocks) {
        try {
          if (block.type === 'text' && block.text) {
            const displayText = noRedact ? block.text : redact(block.text).text;
            md.push('**Assistant:**');
            md.push('');
            md.push(displayText);
            md.push('');
          } else if (block.type === 'thinking' && block.thinking) {
            if (thinking) {
              md.push(formatThinkingBlock(block.thinking));
            }
          } else if (block.type === 'tool_use') {
            md.push(formatToolUseBlock(block.name, block.input, maxResultLen));
          }
        } catch {
          // Skip malformed blocks
        }
      }
    }

    md.push('---');
    md.push('');
  }

  const markdown = md.join('\n');

  // Resolve output path
  const sessionId = meta.sessionId || basename(inputPath, '.jsonl');
  const date = firstTs ? firstTs.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const outputPath = output || join(TRANSCRIPTS_DIR, `${date}-${sessionId.slice(0, 8)}.md`);

  mkdirSync(join(outputPath, '..'), { recursive: true });
  writeFileSync(outputPath, markdown, 'utf8');

  return { outputPath, turnCount: turns.length };
}

function extractUserContent(content) {
  if (typeof content === 'string') {
    return { text: content, toolResultBlocks: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', toolResultBlocks: [] };
  }
  const textParts = content.filter(c => c.type === 'text').map(c => c.text);
  const toolResultBlocks = content.filter(c => c.type === 'tool_result');
  return { text: textParts.join('\n'), toolResultBlocks };
}

/**
 * List all projects that have session transcripts.
 */
export function listAllProjects() {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];
  const dirs = readdirSync(CLAUDE_PROJECTS_DIR);
  const results = [];
  for (const dir of dirs) {
    const projectDir = join(CLAUDE_PROJECTS_DIR, dir);
    if (!statSync(projectDir).isDirectory()) continue;
    const sessions = listSessions(projectDir);
    if (sessions.length === 0) continue;
    // Decode slug back to path: -Users-foo-bar → /Users/foo/bar
    const decoded = dir.replace(/^-/, '/').replace(/-/g, '/');
    results.push({ slug: dir, path: decoded, sessions });
  }
  // Sort by most recent session across all projects
  results.sort((a, b) => {
    const aTs = a.sessions[0]?.lastTimestamp || '';
    const bTs = b.sessions[0]?.lastTimestamp || '';
    return bTs.localeCompare(aTs);
  });
  return results;
}

function resolveProjectDir() {
  // Claude Code encodes CWD as: /Users/foo/bar → -Users-foo-bar
  const cwd = process.cwd();
  const slug = cwd.replace(/\//g, '-');
  const projectDir = join(CLAUDE_PROJECTS_DIR, slug);
  if (existsSync(projectDir)) return projectDir;

  // Fallback: scan CLAUDE_PROJECTS_DIR for a matching directory
  if (existsSync(CLAUDE_PROJECTS_DIR)) {
    const dirs = readdirSync(CLAUDE_PROJECTS_DIR);
    for (const dir of dirs) {
      // Reconstruct path: -Users-foo-bar → /Users/foo/bar
      const decoded = dir.replace(/^-/, '/').replace(/-/g, '/');
      if (decoded === cwd) {
        return join(CLAUDE_PROJECTS_DIR, dir);
      }
    }
  }
  return null;
}
