import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { CONVERSATIONS_LOG_DIR } from '../shared/paths.js';
import { formatToolUseBlock, formatToolResultBlock } from '../shared/md-format.js';

// Track turn counts and current part per file base path
const sessionState = new Map();

function getSessionKey(projectId, sessionPrefix) {
  return `${projectId}/${sessionPrefix}`;
}

function resolveFilePath(projectId, date, sessionPrefix, part) {
  const projectDir = join(CONVERSATIONS_LOG_DIR, projectId || 'default');
  mkdirSync(projectDir, { recursive: true });
  const suffix = part > 1 ? `-part${part}` : '';
  return join(projectDir, `${date}-${sessionPrefix}${suffix}.md`);
}

function writeHeader(filePath, event, part) {
  const header = [
    `# Conversation Log`,
    '',
    `- **Project:** ${event.project_id || 'default'}`,
    `- **Session:** ${event.conversation_id || 'unresolved'}`,
    `- **Model:** ${event.request.model}`,
    `- **Date:** ${event.captured_at.slice(0, 10)}`,
    part > 1 ? `\n> Continued from part ${part - 1}\n` : '',
    '---',
    '',
  ].join('\n');
  appendFileSync(filePath, header, 'utf8');
}

export function logTurnToMarkdown(event, mdConfig) {
  const date = event.captured_at.slice(0, 10);
  const sessionId = event.conversation_id || 'unresolved';
  const sessionPrefix = sessionId.slice(0, 8);
  const projectId = event.project_id || 'default';
  const maxLen = mdConfig.maxToolInputLength || 50000;
  const maxFileSizeBytes = (mdConfig.maxFileSizeKB || 512) * 1024;
  const key = getSessionKey(projectId, sessionPrefix);

  // Initialize or retrieve session state
  if (!sessionState.has(key)) {
    sessionState.set(key, { turn: 0, part: 1 });
  }
  const state = sessionState.get(key);
  state.turn++;

  // Resolve file path and check for split
  let filePath = resolveFilePath(projectId, date, sessionPrefix, state.part);
  if (existsSync(filePath)) {
    try {
      const size = statSync(filePath).size;
      if (size >= maxFileSizeBytes) {
        state.part++;
        filePath = resolveFilePath(projectId, date, sessionPrefix, state.part);
      }
    } catch { /* proceed with current file */ }
  }

  // Write header if new file
  if (!existsSync(filePath)) {
    writeHeader(filePath, event, state.part);
  }

  // Build turn content
  const lines = [];
  const time = event.captured_at.slice(11, 19);
  lines.push(`### Turn ${state.turn} — ${time}`);
  lines.push('');

  // User text
  if (event.request.user_text) {
    lines.push('**User:**');
    lines.push('');
    lines.push(event.request.user_text);
    lines.push('');
  }

  // User tool results (from the fix)
  if (event.request.tool_results?.length > 0) {
    for (const tr of event.request.tool_results) {
      lines.push(formatToolResultBlock(tr.content, maxLen));
    }
  }

  // Assistant text
  if (event.response.assistant_text) {
    lines.push('**Assistant:**');
    lines.push('');
    lines.push(event.response.assistant_text);
    lines.push('');
  }

  // Tool uses
  if (event.response.tool_uses?.length > 0) {
    for (const tu of event.response.tool_uses) {
      lines.push(formatToolUseBlock(tu.name, tu.input, maxLen));
    }
  }

  lines.push('---');
  lines.push('');

  appendFileSync(filePath, lines.join('\n'), 'utf8');
}
