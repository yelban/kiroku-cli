import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_PROJECTS_DIR } from './paths.js';

let _cache = new Map(); // projectId -> { conversationId, checkedAt }

export function resolveSessionId(projectId) {
  const now = Date.now();
  const cached = _cache.get(projectId);
  if (cached && (now - cached.checkedAt) < 5000) {
    return cached.conversationId;
  }

  const escapedPath = projectIdToEscapedPath(projectId);
  const sessionDir = join(CLAUDE_PROJECTS_DIR, escapedPath);

  try {
    const files = readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'));

    if (files.length === 0) return null;

    // Find the most recently modified .jsonl file
    let latest = null;
    let latestMtime = 0;
    for (const file of files) {
      const stat = statSync(join(sessionDir, file));
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latest = file;
      }
    }

    if (!latest) return null;

    // File name is the session UUID (without .jsonl extension)
    const conversationId = latest.replace('.jsonl', '');
    _cache.set(projectId, { conversationId, checkedAt: now });
    return conversationId;
  } catch {
    return null;
  }
}

function projectIdToEscapedPath(projectId) {
  // Convert CWD slug back to escaped path format
  // e.g., "Users-orz99-zoo-claude-proxy" -> "-Users-orz99-zoo-claude-proxy"
  // The escaped path format uses leading dash for absolute paths
  if (!projectId.startsWith('-')) {
    return '-' + projectId;
  }
  return projectId;
}

export function getProjectSlug(cwd) {
  return cwd.replace(/[\\/]/g, '-').replace(/^-/, '');
}

export function clearSessionCache() {
  _cache.clear();
}
