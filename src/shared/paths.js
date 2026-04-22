import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// CJS-safe: in esbuild CJS bundle, import.meta.url is undefined
// bin/kiroku.js always sets KIROKU_ROOT env before spawning daemons
function resolveRoot() {
  if (process.env.KIROKU_ROOT) return process.env.KIROKU_ROOT;
  if (import.meta.url) return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return join(process.cwd()); // last resort
}
export const KIROKU_ROOT = resolveRoot();
export const KIROKU_HOME = join(homedir(), '.kiroku');
export const CONFIG_PATH = join(KIROKU_HOME, 'config.json');
export const LICENSE_DIR = join(KIROKU_HOME, 'license');
export const DATA_DIR = join(KIROKU_HOME, 'data');
export const DB_PATH = join(DATA_DIR, 'memory.sqlite');
export const QUEUE_DIR = join(DATA_DIR, 'queue');
export const QUEUE_INCOMING = join(QUEUE_DIR, 'incoming');
export const QUEUE_PROCESSING = join(QUEUE_DIR, 'processing');
export const QUEUE_DONE = join(QUEUE_DIR, 'done');
export const QUEUE_DEAD = join(QUEUE_DIR, 'dead-letter');
export const EXPORTS_DIR = join(DATA_DIR, 'exports');
export const CACHE_DIR = join(DATA_DIR, 'cache');
export const MODEL_CACHE_DIR = join(CACHE_DIR, 'models');
export const LOG_DIR = join(KIROKU_HOME, 'logs');
export const CONVERSATIONS_LOG_DIR = join(LOG_DIR, 'conversations');
export const TRANSCRIPTS_DIR = join(LOG_DIR, 'transcripts');
export const RUN_DIR = join(KIROKU_HOME, 'run');
export const SESSIONS_DIR = join(RUN_DIR, 'sessions');
export const PROXY_STATE_PATH = join(RUN_DIR, 'proxy.state.json');
export const WORKER_STATE_PATH = join(RUN_DIR, 'worker.state.json');
export const BACKUP_DIR = join(KIROKU_HOME, 'backups');
export const RECORDINGS_DIR = join(KIROKU_HOME, 'recordings');
export const PROMPT_CACHE_DIR = join(CACHE_DIR, 'prompt');
export const PROMPT_CACHE_PATH = join(PROMPT_CACHE_DIR, 'prompt.enc');
export const LICENSE_KEY_PATH = join(LICENSE_DIR, 'license.key');
export const OFFLINE_LICENSE_PATH = join(LICENSE_DIR, 'license-offline.json');
export const ENV_PATH = join(KIROKU_HOME, '.env');
export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export function ensureDirs() {
  const dirs = [
    KIROKU_HOME, LICENSE_DIR, DATA_DIR, QUEUE_DIR,
    QUEUE_INCOMING, QUEUE_PROCESSING, QUEUE_DONE, QUEUE_DEAD,
    EXPORTS_DIR, CACHE_DIR, MODEL_CACHE_DIR, PROMPT_CACHE_DIR,
    LOG_DIR, CONVERSATIONS_LOG_DIR, TRANSCRIPTS_DIR,
    RUN_DIR, SESSIONS_DIR, BACKUP_DIR, RECORDINGS_DIR,
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}
