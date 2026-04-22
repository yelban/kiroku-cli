/**
 * Full-text search across Claude Code session transcripts.
 * Scans JSONL files with raw-text pre-filter for performance.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_PROJECTS_DIR } from '../shared/paths.js';

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  inverse: '\x1b[7m',
};

/**
 * Search all session transcripts for a query string.
 * @param {string} query - Search term
 * @param {object} opts
 * @param {string} opts.project - Filter by project slug substring
 * @param {number} opts.maxResults - Max results per session (default 5)
 * @param {number} opts.contextChars - Chars of context around match (default 80)
 */
export function searchTranscripts(query, opts = {}) {
  const { project, maxResults = 5, contextChars = 80 } = opts;
  const queryLower = query.toLowerCase();

  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    console.log('No Claude projects directory found.');
    return [];
  }

  const dirs = readdirSync(CLAUDE_PROJECTS_DIR);
  const results = [];
  let totalMatches = 0;

  for (const dir of dirs) {
    if (project && !dir.toLowerCase().includes(project.toLowerCase())) continue;

    const projectDir = join(CLAUDE_PROJECTS_DIR, dir);
    try { if (!statSync(projectDir).isDirectory()) continue; } catch { continue; }

    const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = join(projectDir, file);
      const sessionId = file.replace('.jsonl', '');

      try {
        const content = readFileSync(filePath, 'utf8');

        // Fast pre-filter: skip entire file if query not present
        if (!content.toLowerCase().includes(queryLower)) continue;

        const lines = content.split('\n');
        const matches = [];
        let sessionDate = null;

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx];
          if (!line.trim()) continue;

          // Fast pre-filter per line
          if (!line.toLowerCase().includes(queryLower)) continue;

          let obj;
          try { obj = JSON.parse(line); } catch { continue; }

          if (!sessionDate && obj.timestamp) {
            sessionDate = obj.timestamp.slice(0, 10);
          }

          if (obj.type !== 'user' && obj.type !== 'assistant') continue;

          const blocks = obj.message?.content;
          if (!blocks) continue;

          const textContent = extractSearchableText(blocks);
          const lowerText = textContent.toLowerCase();
          let searchFrom = 0;

          while (searchFrom < lowerText.length && matches.length < maxResults) {
            const idx = lowerText.indexOf(queryLower, searchFrom);
            if (idx === -1) break;

            const start = Math.max(0, idx - contextChars);
            const end = Math.min(textContent.length, idx + query.length + contextChars);
            const context = textContent.slice(start, end);
            const ts = obj.timestamp ? obj.timestamp.slice(11, 19) : '';

            matches.push({
              turn: lineIdx,
              role: obj.type,
              time: ts,
              context,
              matchIndex: idx - start,
            });

            totalMatches++;
            searchFrom = idx + query.length;
          }

          if (matches.length >= maxResults) break;
        }

        if (matches.length > 0) {
          const decoded = dir.replace(/^-/, '/').replace(/-/g, '/');
          results.push({
            project: decoded,
            slug: dir,
            sessionId,
            sessionDate: sessionDate || '?',
            matches,
          });
        }
      } catch { /* skip unreadable files */ }
    }
  }

  // Sort: most recent first
  results.sort((a, b) => b.sessionDate.localeCompare(a.sessionDate));

  // Render results
  if (results.length === 0) {
    console.log(`No matches found for "${query}".`);
    return results;
  }

  console.log(`${c.bold}Found ${totalMatches} match(es) in ${results.length} session(s):${c.reset}\n`);

  for (const r of results) {
    console.log(`${c.cyan}${r.project}${c.reset}  ${c.gray}${r.sessionDate}${c.reset}  Session ${c.bold}${r.sessionId.slice(0, 8)}${c.reset}`);

    for (const m of r.matches) {
      const highlighted = highlightMatch(m.context, m.matchIndex, query.length);
      const role = m.role === 'user' ? `${c.green}User${c.reset}` : `${c.yellow}Asst${c.reset}`;
      console.log(`  ${c.gray}${m.time}${c.reset} ${role}: ...${highlighted}...`);
    }

    console.log(`  ${c.gray}→ kiroku transcript --view ${r.sessionId.slice(0, 8)}${c.reset}\n`);
  }

  return results;
}

function highlightMatch(context, matchStart, matchLen) {
  const before = context.slice(0, matchStart);
  const match = context.slice(matchStart, matchStart + matchLen);
  const after = context.slice(matchStart + matchLen);
  return `${before}${c.inverse}${c.yellow}${match}${c.reset}${after}`;
}

function extractSearchableText(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';

  const parts = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) parts.push(b.text);
    if (b.type === 'tool_use' && b.input) {
      try {
        const json = typeof b.input === 'string' ? b.input : JSON.stringify(b.input);
        parts.push(json);
      } catch { /* skip */ }
    }
    if (b.type === 'tool_result') {
      const t = extractResultText(b.content);
      if (t) parts.push(t);
    }
  }
  return parts.join('\n');
}

function extractResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => c.type === 'text' ? c.text : `[${c.type}]`).join('\n');
  }
  return '';
}
