/**
 * Terminal-native transcript viewer with ANSI colors.
 * Reads Claude Code JSONL and renders a human-readable, colorized replay.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { CLAUDE_PROJECTS_DIR } from '../shared/paths.js';
import { redact } from '../shared/redact.js';

// ANSI color helpers (no dependencies)
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  bgGray: '\x1b[100m',
  inverse: '\x1b[7m',
};

const MAX_TOOL_INPUT_LEN = 2000;
const MAX_TOOL_RESULT_LEN = 3000;

/**
 * View a session transcript in the terminal with ANSI colors.
 * @param {string} sessionIdOrPath - Session ID (UUID prefix) or full file path
 * @param {object} opts
 * @param {boolean} opts.thinking - Include thinking blocks
 * @param {boolean} opts.noRedact - Skip DLP redaction
 * @param {boolean} opts.noPager - Print directly instead of piping to less
 */
export function viewTranscript(sessionIdOrPath, opts = {}) {
  const { thinking = false, noRedact = false, noPager = false } = opts;

  const inputPath = resolveInputPath(sessionIdOrPath);
  const content = readFileSync(inputPath, 'utf8');
  const rawLines = content.split('\n').filter(l => l.trim());
  const entries = [];
  for (const line of rawLines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip */ }
  }

  const fileSessionId = basename(inputPath, '.jsonl');
  const meaningful = entries.filter(e => {
    if (e.isSidechain || e.isMeta) return false;
    if (e.type === 'progress' || e.type === 'file-history-snapshot' || e.type === 'system') return false;
    if (e.sessionId && e.sessionId !== fileSessionId) return false;
    return e.type === 'user' || e.type === 'assistant';
  });

  const meta = entries.find(e => e.sessionId === fileSessionId)
    || entries.find(e => e.sessionId) || {};

  // Group into turns
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

  // Build output
  const out = [];

  // Header
  out.push(`${c.bold}${c.blue}${'═'.repeat(60)}${c.reset}`);
  out.push(`${c.bold} Conversation Transcript${c.reset}`);
  if (meta.sessionId) out.push(`${c.gray} Session:  ${meta.sessionId}${c.reset}`);
  if (meta.cwd) out.push(`${c.gray} CWD:     ${meta.cwd}${c.reset}`);
  if (meta.version) out.push(`${c.gray} Claude:  v${meta.version}${c.reset}`);
  const firstTs = meaningful[0]?.timestamp;
  if (firstTs) out.push(`${c.gray} Date:    ${firstTs.slice(0, 10)}${c.reset}`);
  out.push(`${c.bold}${c.blue}${'═'.repeat(60)}${c.reset}`);
  out.push('');

  // Collect tool_use blocks to pair with tool_result
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const ts = turn.user.timestamp ? turn.user.timestamp.slice(11, 19) : '';

    out.push(`${c.bold}${c.blue}── Turn ${i + 1}${ts ? ` — ${ts}` : ''} ${'─'.repeat(40)}${c.reset}`);
    out.push('');

    // Gather pending tool_uses from previous assistant (for matching with tool_results)
    const prevToolUses = i > 0 ? collectToolUses(turns[i - 1]) : new Map();

    // User message
    const userContent = turn.user.message?.content;
    if (userContent) {
      const { text: userText, toolResultBlocks } = extractUserContent(userContent);
      if (userText) {
        const displayText = noRedact ? userText : redact(userText).text;
        out.push(`${c.bold}${c.green}User:${c.reset}`);
        out.push(displayText);
        out.push('');
      }

      // Tool results (including AskUserQuestion answers)
      for (const tr of toolResultBlocks) {
        const matchedToolUse = prevToolUses.get(tr.tool_use_id);
        if (matchedToolUse && matchedToolUse.name === 'AskUserQuestion') {
          out.push(formatAskUserQuestion(matchedToolUse.input, tr.content));
        } else {
          const resultText = extractToolResultText(tr.content);
          if (resultText) {
            const name = matchedToolUse?.name || 'unknown';
            out.push(`${c.gray}  ┌─ Result: ${name}${c.reset}`);
            const truncated = resultText.length > MAX_TOOL_RESULT_LEN
              ? resultText.slice(0, MAX_TOOL_RESULT_LEN) + `\n${c.gray}  [truncated: ${resultText.length} chars]${c.reset}`
              : resultText;
            for (const line of truncated.split('\n')) {
              out.push(`${c.gray}  │ ${line}${c.reset}`);
            }
            out.push(`${c.gray}  └─${c.reset}`);
            out.push('');
          }
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
            out.push(`${c.bold}${c.yellow}Assistant:${c.reset}`);
            out.push(displayText);
            out.push('');
          } else if (block.type === 'thinking' && block.thinking && thinking) {
            out.push(`${c.dim}${c.cyan}┌─ Thinking ─────────────────────${c.reset}`);
            for (const line of block.thinking.split('\n').slice(0, 20)) {
              out.push(`${c.dim}${c.cyan}│ ${line}${c.reset}`);
            }
            if (block.thinking.split('\n').length > 20) {
              out.push(`${c.dim}${c.cyan}│ ... (${block.thinking.split('\n').length} lines total)${c.reset}`);
            }
            out.push(`${c.dim}${c.cyan}└────────────────────────────────${c.reset}`);
            out.push('');
          } else if (block.type === 'tool_use') {
            if (block.name === 'AskUserQuestion') {
              // Will be rendered when we see the tool_result in the next turn
              out.push(`${c.cyan}[?] AskUserQuestion pending...${c.reset}`);
              out.push('');
            } else {
              out.push(formatToolUse(block.name, block.input));
              out.push('');
            }
          }
        } catch { /* skip malformed */ }
      }
    }
  }

  const output = out.join('\n');

  if (noPager) {
    process.stdout.write(output + '\n');
    return;
  }

  // Pipe to less -R for ANSI color support
  return new Promise((resolve) => {
    const less = spawn('less', ['-R', '-S', '--quit-if-one-screen', '-X'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    less.stdin.write(output);
    less.stdin.end();
    less.on('close', resolve);
    less.on('error', () => {
      // Fallback: print directly
      process.stdout.write(output + '\n');
      resolve();
    });
  });
}

/**
 * Format AskUserQuestion with selected/unselected options.
 */
function formatAskUserQuestion(toolInput, resultContent) {
  const lines = [];
  const questions = toolInput?.questions || [];
  const answerText = extractToolResultText(resultContent);
  const answerMap = parseAskAnswers(answerText);

  for (const q of questions) {
    lines.push(`${c.bold}${c.cyan}  [?] ${q.question}${c.reset}`);
    if (q.header) lines.push(`${c.gray}      (${q.header})${c.reset}`);
    lines.push('');

    const selectedLabels = answerMap.get(q.question) || '';

    for (const opt of (q.options || [])) {
      const isSelected = selectedLabels.includes(opt.label);
      if (isSelected) {
        lines.push(`${c.green}      ● ${opt.label}${c.reset}`);
        if (opt.description) lines.push(`${c.green}        ${opt.description}${c.reset}`);
      } else {
        lines.push(`${c.gray}      ○ ${opt.label}${c.reset}`);
        if (opt.description) lines.push(`${c.gray}        ${opt.description}${c.reset}`);
      }
    }

    // Show user notes if present
    const notesMatch = answerText.match(/user notes:\s*(.+)/i);
    if (notesMatch) {
      lines.push('');
      lines.push(`${c.dim}${c.yellow}      Notes: ${notesMatch[1].trim()}${c.reset}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Parse "User has answered your questions: "Q"="A"" format.
 */
function parseAskAnswers(text) {
  const map = new Map();
  if (!text) return map;
  const matches = text.matchAll(/"([^"]+)"="([^"]+)"/g);
  for (const m of matches) {
    map.set(m[1], m[2]);
  }
  return map;
}

/**
 * Format a tool_use block for terminal display.
 */
function formatToolUse(name, input) {
  let json;
  try {
    json = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  } catch {
    json = String(input);
  }
  if (json.length > MAX_TOOL_INPUT_LEN) {
    json = json.slice(0, MAX_TOOL_INPUT_LEN) + `\n[truncated: ${json.length} chars]`;
  }
  const lines = [`${c.gray}  ┌─ Tool: ${name}${c.reset}`];
  for (const line of json.split('\n')) {
    lines.push(`${c.gray}  │ ${line}${c.reset}`);
  }
  lines.push(`${c.gray}  └─${c.reset}`);
  return lines.join('\n');
}

/**
 * Collect tool_use blocks from a turn's assistant messages, keyed by tool_use_id.
 */
function collectToolUses(turn) {
  const map = new Map();
  for (const asst of turn.assistants) {
    const blocks = asst.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.id) {
        map.set(b.id, b);
      }
    }
  }
  return map;
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

function extractToolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return '[image]';
        return `[${c.type}]`;
      })
      .join('\n');
  }
  try { return JSON.stringify(content, null, 2); } catch { return String(content); }
}

function resolveInputPath(sessionIdOrPath) {
  if (existsSync(sessionIdOrPath)) return sessionIdOrPath;

  const projectDir = resolveProjectDir();
  if (projectDir) {
    // Exact match
    const exact = join(projectDir, `${sessionIdOrPath}.jsonl`);
    if (existsSync(exact)) return exact;

    // Prefix match (short UUID)
    const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    const match = files.find(f => f.startsWith(sessionIdOrPath));
    if (match) return join(projectDir, match);
  }

  // Scan all projects for prefix match
  if (existsSync(CLAUDE_PROJECTS_DIR)) {
    for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
      const pd = join(CLAUDE_PROJECTS_DIR, dir);
      try {
        const files = readdirSync(pd).filter(f => f.endsWith('.jsonl'));
        const match = files.find(f => f.startsWith(sessionIdOrPath));
        if (match) return join(pd, match);
      } catch { /* skip */ }
    }
  }

  throw new Error(`Session not found: ${sessionIdOrPath}`);
}

function resolveProjectDir() {
  const cwd = process.cwd();
  const slug = cwd.replace(/\//g, '-');
  const projectDir = join(CLAUDE_PROJECTS_DIR, slug);
  if (existsSync(projectDir)) return projectDir;
  return null;
}
