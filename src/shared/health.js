import { existsSync, readdirSync } from 'node:fs';
import { DB_PATH, QUEUE_INCOMING, QUEUE_PROCESSING, QUEUE_DEAD, CONFIG_PATH, MODEL_CACHE_DIR } from './paths.js';

/**
 * Gather system health info. Used by both CLI (doctor/status) and MCP tool.
 * Does NOT check proxy/worker daemon status (unreliable from MCP context).
 */
export async function getSystemHealth(config) {
  const components = {};
  const issues = [];

  // ── Database ──
  if (existsSync(DB_PATH)) {
    try {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(DB_PATH, { readonly: true });
      const projects = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
      const facts = db.prepare("SELECT COUNT(*) as c FROM facts WHERE status = 'active'").get().c;
      const entities = db.prepare('SELECT COUNT(*) as c FROM entities').get().c;
      const turns = db.prepare('SELECT COUNT(*) as c FROM turns').get().c;
      db.close();
      components.database = { status: 'ok', projects, facts, entities, turns };
    } catch (err) {
      components.database = { status: 'error', error: err.message };
      issues.push(`Database error: ${err.message}`);
    }
  } else {
    components.database = { status: 'missing' };
    issues.push('Database not initialized');
  }

  // ── Queue ──
  try {
    const incoming = existsSync(QUEUE_INCOMING) ? readdirSync(QUEUE_INCOMING).filter(f => f.endsWith('.jsonl')).length : 0;
    const processing = existsSync(QUEUE_PROCESSING) ? readdirSync(QUEUE_PROCESSING).filter(f => f.endsWith('.jsonl')).length : 0;
    const deadLetter = existsSync(QUEUE_DEAD) ? readdirSync(QUEUE_DEAD).filter(f => f.endsWith('.jsonl')).length : 0;
    components.queue = { incoming, processing, dead_letter: deadLetter };
  } catch {
    components.queue = { incoming: 0, processing: 0, dead_letter: 0 };
  }

  // ── Embedding model ──
  let modelCached = false;
  if (existsSync(MODEL_CACHE_DIR)) {
    try {
      const files = readdirSync(MODEL_CACHE_DIR, { recursive: true });
      modelCached = files.length > 0;
    } catch {}
  }

  let coveragePercent = 0;
  if (existsSync(DB_PATH)) {
    try {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(DB_PATH, { readonly: true });
      const factCount = db.prepare("SELECT COUNT(*) as c FROM facts WHERE status = 'active'").get().c;
      let embCount = 0;
      try {
        const sqliteVec = await import('sqlite-vec');
        sqliteVec.load(db);
        embCount = db.prepare('SELECT COUNT(*) as c FROM fact_embeddings').get().c;
      } catch {}
      db.close();
      coveragePercent = factCount > 0 ? Math.round((embCount / factCount) * 100) : 100;
    } catch {}
  }
  components.embedding_model = { cached: modelCached, coverage_percent: coveragePercent };

  // ── Extraction key ──
  // The key lives in Worker's env (loaded from ~/.kiroku/.env at startup).
  // MCP/CLI may not have it — check env first, then fall back to .env file.
  const apiKeyEnv = config?.worker?.extraction?.apiKeyEnv || 'OPENROUTER_API_KEY';
  let keySet = !!process.env[apiKeyEnv];
  if (!keySet) {
    try {
      const { join } = await import('node:path');
      const { readFileSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const envPath = join(homedir(), '.kiroku', '.env');
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf8');
        keySet = content.split('\n').some(l => l.startsWith(apiKeyEnv + '=') && l.split('=')[1]?.trim());
      }
    } catch {}
  }
  components.extraction_key = { set: keySet, env_var: apiKeyEnv };
  if (!keySet) issues.push(`${apiKeyEnv} not set in env or ~/.kiroku/.env`);

  // ── License ──
  try {
    const { getLicenseState } = await import('../license/license-state.js');
    const ls = await getLicenseState();
    components.license = {
      licensed: ls.licensed,
      tier: ls.tier || 'free',
      expiry: ls.expiry ? ls.expiry.toISOString().slice(0, 10) : null,
      machine_id: ls.machineId || null,
    };
  } catch (err) {
    components.license = { licensed: false, tier: 'unknown', error: err.message };
    issues.push(`License check error: ${err.message}`);
  }

  const status = issues.length === 0 ? 'healthy' : 'degraded';
  return { status, components, issues };
}
