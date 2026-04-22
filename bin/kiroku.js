#!/usr/bin/env node

import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, chmodSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

// ESM: derive from import.meta.url — CJS bundle: import.meta.url is undefined
const __curdir = (() => {
  try { if (import.meta.url) return dirname(fileURLToPath(import.meta.url)); } catch {}
  // CJS fallback: __filename is available in CommonJS modules
  try { return dirname(__filename); } catch {}
  return process.cwd();
})();
const ROOT = resolve(__curdir, '..');

// Resolve src/ (dev) or dist/ (published) — dist/ bundles are CJS requiring createRequire
const HAS_DIST = existsSync(join(ROOT, 'dist', 'proxy.cjs'));
const HAS_SRC = existsSync(join(ROOT, 'src', 'shared', 'paths.js'));
const USE_DIST = HAS_DIST && !HAS_SRC;

// Set KIROKU_ROOT so bundled code can find migrations/
process.env.KIROKU_ROOT = ROOT;

// Read version from package.json
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
})();

// Lazy imports to avoid loading heavy modules for simple commands
async function paths() { return await import('../src/shared/paths.js'); }
async function config() { return await import('../src/shared/config.js'); }

const cmd = process.argv[2] || '';
let args = process.argv.slice(3);

const COMMANDS = {
  init: cmdInit,
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  doctor: cmdDoctor,
  export: cmdExport,
  reindex: cmdReindex,
  transcript: cmdTranscript,
  activate: cmdActivate,
  deactivate: cmdDeactivate,
  license: cmdLicense,
  rec: cmdRec,
  play: cmdPlay,
  recs: cmdRecs,
  'hook-on-stop': cmdHookOnStop,
  help: cmdHelp,
};

const handler = COMMANDS[cmd];
if (handler) {
  Promise.resolve(handler()).catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else if (cmd === '--version' || cmd === '-V') {
  console.log(PKG_VERSION);
  process.exit(0);
} else if (!cmd || (cmd.startsWith('-') && cmd !== '--help' && cmd !== '-h')) {
  // No subcommand or flag → default to start, pass everything to claude
  if (cmd) args = process.argv.slice(2);
  Promise.resolve(cmdStart()).catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else {
  if (cmd && cmd !== '--help' && cmd !== '-h') {
    console.error(`Unknown command: ${cmd}`);
  }
  cmdHelp();
  process.exit(cmd ? 1 : 0);
}

// ─── Commands ─────────────────────────────────────────

async function cmdInit() {
  const { ensureDirs, CONFIG_PATH, DB_PATH } = await paths();
  const { saveDefaultConfig, loadConfig } = await config();

  console.log(`Initializing Kiroku v${PKG_VERSION}...`);

  // Create directories
  ensureDirs();
  console.log('  Created ~/.kiroku/ directory structure');

  // Write default config
  saveDefaultConfig();
  console.log(`  Config: ${CONFIG_PATH}`);

  // Initialize database
  const { initDb, runMigrations, closeDb } = await import('../src/shared/db.js');
  await initDb();
  runMigrations();
  closeDb();
  console.log(`  Database: ${DB_PATH}`);

  // Interactive provider setup (skip in CI/pipe)
  if (process.stdin.isTTY) {
    await interactiveProviderSetup();
  }

  // Optionally append memory section to CLAUDE.md
  const claudeMdPath = join(process.cwd(), 'CLAUDE.md');
  const memorySection = `\n## Memory (Kiroku)\n- Use memory_search to check relevant history before starting new tasks\n- Use memory_save when the user says "remember" or states important decisions\n- Use memory_forget when the user says "forget" or information is outdated\n`;

  if (existsSync(claudeMdPath)) {
    const content = readFileSync(claudeMdPath, 'utf8');
    if (!content.includes('## Memory (Kiroku)')) {
      writeFileSync(claudeMdPath, content + memorySection);
      console.log('  Appended memory section to CLAUDE.md');
    } else {
      console.log('  CLAUDE.md already has memory section');
    }
  }

  console.log('\nDone! Run `kiroku start` to begin.');
}

async function cmdStart() {
  const p = await paths();

  // Auto-init on first run
  if (!existsSync(p.DB_PATH)) {
    console.log('First run detected, initializing...');
    await cmdInit();
    console.log('');
  }

  const { loadConfig } = await config();
  const cfg = loadConfig();

  // License check — gentle reminder for free tier
  if (cfg.license.enabled) {
    const { getLicenseState } = await import('../src/license/license-state.js');
    const ls = await getLicenseState();
    if (!ls.licensed) {
      console.log(`\n  \u26A0 Kiroku is running in free mode (${ls.factLimit} facts, no vector search)`);
      if (ls.machineId) {
        console.log(`    Machine ID: ${ls.machineId}`);
      }
      console.log(`    Activate: https://kiroku.dev/activate\n`);
    }
  }

  console.log(`Starting Kiroku v${PKG_VERSION}...`);

  // Check/start proxy with lock to prevent concurrent startups
  const proxyLockPath = join(p.RUN_DIR, 'proxy.lock');
  const existingProxy = await getProxyState(p);
  if (existingProxy) {
    console.log(`Proxy already running on port ${existingProxy.port}`);
  } else if (acquireStartupLock(proxyLockPath)) {
    try {
      // Re-check after acquiring lock (another process may have started it)
      const recheck = await getProxyState(p);
      if (recheck) {
        console.log(`Proxy already running on port ${recheck.port}`);
      } else {
        await startProxyDaemon(p);
      }
    } finally {
      try { unlinkSync(proxyLockPath); } catch {}
    }
  } else {
    // Another process holds the lock — wait for proxy to become ready
    console.log('Waiting for proxy (another instance starting)...');
    const ready = await waitForProxyState(p, 20);
    if (ready) {
      console.log(`Proxy ready (port ${ready.port})`);
    } else {
      console.error('Timed out waiting for proxy');
      process.exit(1);
    }
  }

  // Check/start worker with same lock pattern
  const workerLockPath = join(p.RUN_DIR, 'worker.lock');
  const existingWorker = getWorkerState(p);
  if (existingWorker) {
    console.log(`Worker already running (PID ${existingWorker.pid})`);
  } else if (cfg.worker.enabled) {
    if (acquireStartupLock(workerLockPath)) {
      try {
        const recheckW = getWorkerState(p);
        if (recheckW) {
          console.log(`Worker already running (PID ${recheckW.pid})`);
        } else {
          await startWorkerDaemon(p);
        }
      } finally {
        try { unlinkSync(workerLockPath); } catch {}
      }
    } else {
      console.log('Waiting for worker (another instance starting)...');
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (getWorkerState(p)) break;
      }
    }
  }

  // Read proxy state for Claude launch
  const proxyState = await getProxyState(p);
  if (!proxyState) {
    console.error('Failed to start proxy');
    process.exit(1);
  }

  // Write .mcp.json for MCP server registration
  const mcpJsonPath = join(process.cwd(), '.mcp.json');
  const projectSlug = process.cwd().replace(/[\\/]/g, '-').replace(/^-/, '');
  const mcpScript = USE_DIST
    ? join(ROOT, 'dist', 'mcp.cjs')
    : join(ROOT, 'src', 'mcp', 'server.js');
  const mcpConfig = {
    mcpServers: {
      'kiroku-memory': {
        command: 'node',
        args: [mcpScript],
        env: { KIROKU_PROJECT_ID: projectSlug, KIROKU_ROOT: ROOT },
      },
    },
  };

  // Merge with existing .mcp.json if present
  if (existsSync(mcpJsonPath)) {
    try {
      const existing = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
      if (existing.mcpServers) {
        existing.mcpServers['kiroku-memory'] = mcpConfig.mcpServers['kiroku-memory'];
        writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n');
      } else {
        writeFileSync(mcpJsonPath, JSON.stringify({ ...existing, ...mcpConfig }, null, 2) + '\n');
      }
    } catch {
      writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n');
    }
  } else {
    writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n');
  }
  console.log(`  MCP config: ${mcpJsonPath}`);

  // Write hooks to settings.local.json
  const settingsDir = join(process.cwd(), '.claude');
  const settingsPath = join(settingsDir, 'settings.local.json');
  // Use dist/cli.cjs (npm install) or bin/kiroku.js (dev) for the hook command
  const hookBin = USE_DIST
    ? join(ROOT, 'dist', 'cli.cjs')
    : join(ROOT, 'bin', 'kiroku.js');
  const stopHookCmd = `node ${hookBin} hook-on-stop`;

  // Create SessionStart hook script (bash + sqlite3, no Node overhead)
  // Fires on: startup, resume, clear, compact — re-injects after context compaction
  const hookDir = join(homedir(), '.kiroku', 'hooks');
  const sessionHookPath = join(hookDir, 'on-session-start.sh');
  try {
    const { mkdirSync: mkdirSyncFs, chmodSync: chmodSyncFs } = await import('node:fs');
    mkdirSyncFs(hookDir, { recursive: true });
    // Write bash script directly — avoids JS string escaping hell
    const scriptSql = `SELECT '[' || f.fact_type || '] ' || COALESCE(e.canonical_name, '?') || ' '
    || f.predicate || ' ' || f.object_text
    || CASE WHEN f.object_detail IS NOT NULL AND f.object_detail <> '' THEN ' -- ' || f.object_detail ELSE '' END
    || CASE WHEN f.scope = 'global' THEN ' [global]' ELSE '' END
  FROM facts f LEFT JOIN entities e ON f.subject_entity_id = e.id
  WHERE f.status = 'active'
    AND ((f.project_id = '\$PROJECT_ID' AND f.scope = 'project') OR f.scope = 'global')
  ORDER BY CASE f.fact_type
      WHEN 'preference' THEN 0 WHEN 'semantic' THEN 1 WHEN 'task' THEN 2
      WHEN 'state' THEN 3 WHEN 'episodic' THEN 4 ELSE 5 END,
    f.heat * (1.0 + MIN(f.access_count, 20) * 0.1) DESC
  LIMIT 30`;
    writeFileSync(sessionHookPath,
`#!/bin/bash
# Kiroku: inject project memory at session start
# Fires on: startup, resume, clear, compact
DB="\$HOME/.kiroku/data/memory.sqlite"
[ -f "\$DB" ] || exit 0
command -v sqlite3 >/dev/null || exit 0
INPUT=\$(cat)
CWD=\$(echo "\$INPUT" | grep -o '"cwd":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -z "\$CWD" ] && exit 0
PROJECT_ID=\$(echo "\$CWD" | tr '/' '-' | sed "s/^-//; s/'/''/g")
FACTS=\$(sqlite3 "\$DB" "${scriptSql}" 2>/dev/null)
[ -z "\$FACTS" ] && exit 0
printf '# Project Memory (auto-loaded)\\n\\n%s\\n' "\$FACTS"
`);
    chmodSyncFs(sessionHookPath, 0o755);

    mkdirSyncFs(settingsDir, { recursive: true });
    let settings = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {}
    }
    if (!settings.hooks) settings.hooks = {};

    // Stop hook: remove stale, register current
    if (!settings.hooks.Stop) settings.hooks.Stop = [];
    settings.hooks.Stop = settings.hooks.Stop.filter(
      h => !h.hooks?.some(hh => /\bhook-on-stop\b/.test(hh.command))
    );
    settings.hooks.Stop.push({
      matcher: '',
      hooks: [{ type: 'command', command: stopHookCmd }],
    });

    // SessionStart hook: remove stale, register current
    if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter(
      h => !h.hooks?.some(hh => /kiroku|on-session-start/.test(hh.command))
    );
    settings.hooks.SessionStart.push({
      matcher: '',
      hooks: [{ type: 'command', command: `bash ${sessionHookPath}` }],
    });

    // Clean up old UserPromptSubmit hooks (replaced by SessionStart)
    if (settings.hooks.UserPromptSubmit) {
      settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
        h => !h.hooks?.some(hh => /kiroku|on-prompt/.test(hh.command))
      );
      if (settings.hooks.UserPromptSubmit.length === 0) delete settings.hooks.UserPromptSubmit;
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch (err) {
    // Non-fatal: hook registration is best-effort
  }

  // Write session state for tmux-resurrect
  const sessionSlug = projectSlug;
  const sessionDir = join(p.RUN_DIR, 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, `${sessionSlug}.json`);
  const originalArgs = process.argv.slice(2);
  writeFileSync(sessionPath, JSON.stringify({
    cwd: process.cwd(),
    argv: originalArgs,
    command: `kiroku ${originalArgs.join(' ')}`.trim(),
    startedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  // Set up environment and launch Claude
  const env = { ...process.env };
  const baseUrl = `http://127.0.0.1:${proxyState.port}/project/${encodeURIComponent(projectSlug)}`;
  env.ANTHROPIC_BASE_URL = baseUrl;
  console.log(`  Proxy: ${baseUrl}`);

  // Heartbeat timer
  const heartbeatTimer = setInterval(() => {
    http.get(`http://127.0.0.1:${proxyState.port}/heartbeat?secret=${proxyState.secret}`)
      .on('error', () => {});
  }, 30000);

  // Launch Claude CLI
  const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  console.log('\nLaunching Claude Code...\n');

  const child = spawn(claudeCmd, args, {
    stdio: 'inherit',
    env,
    shell: true,
  });

  child.on('exit', (code) => {
    clearInterval(heartbeatTimer);
    try { unlinkSync(sessionPath); } catch {}
    process.exit(code || 0);
  });

  child.on('error', (err) => {
    clearInterval(heartbeatTimer);
    console.error(`Failed to launch Claude: ${err.message}`);
    console.log(`You can manually set ANTHROPIC_BASE_URL=${baseUrl}`);
  });
}

async function cmdStop() {
  const p = await paths();

  // Stop proxy
  const proxyState = await getProxyState(p);
  if (proxyState) {
    try {
      await httpGet(`http://127.0.0.1:${proxyState.port}/suicide?secret=${proxyState.secret}`);
      console.log('Proxy stopped');
    } catch {
      console.log('Proxy not responding, cleaning state file');
      try { unlinkSync(p.PROXY_STATE_PATH); } catch {}
    }
  } else {
    console.log('No proxy running');
  }

  // Stop worker
  const workerState = getWorkerState(p);
  if (workerState) {
    try {
      process.kill(workerState.pid, 'SIGTERM');
      console.log('Worker stopped');
    } catch {
      console.log('Worker not responding, cleaning state file');
    }
    try { unlinkSync(p.WORKER_STATE_PATH); } catch {}
  } else {
    console.log('No worker running');
  }

  // Clean session state
  const slug = process.cwd().replace(/[\\/]/g, '-').replace(/^-/, '');
  const sessFile = join(p.RUN_DIR, 'sessions', `${slug}.json`);
  try { unlinkSync(sessFile); } catch {}
}

async function cmdStatus() {
  const p = await paths();

  // Proxy status
  const proxyState = await getProxyState(p);
  if (proxyState) {
    console.log(`Proxy:  RUNNING (port ${proxyState.port}, PID ${proxyState.pid})`);
  } else {
    console.log('Proxy:  STOPPED');
  }

  // Worker status
  const workerState = getWorkerState(p);
  if (workerState && isProcessAlive(workerState.pid)) {
    console.log(`Worker: RUNNING (PID ${workerState.pid})`);
  } else {
    console.log('Worker: STOPPED');
  }

  // MCP status
  const mcpJsonPath = join(process.cwd(), '.mcp.json');
  if (existsSync(mcpJsonPath)) {
    try {
      const mcp = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
      if (mcp.mcpServers?.['kiroku-memory']) {
        console.log('MCP:    REGISTERED');
      } else {
        console.log('MCP:    NOT REGISTERED');
      }
    } catch {
      console.log('MCP:    ERROR reading .mcp.json');
    }
  } else {
    console.log('MCP:    NOT CONFIGURED');
  }

  // System health
  const { loadConfig } = await config();
  const { getSystemHealth } = await import('../src/shared/health.js');
  const health = await getSystemHealth(loadConfig());

  const db = health.components.database;
  if (db.status === 'ok') {
    console.log(`\nDB Stats: ${db.projects} projects, ${db.turns} turns, ${db.facts} active facts, ${db.entities} entities`);
  } else {
    console.log(`\nDB: ${db.status === 'missing' ? 'Not initialized (run `kiroku init`)' : `Error (${db.error})`}`);
  }

  const q = health.components.queue;
  console.log(`Queue:  ${q.incoming} incoming, ${q.processing} processing, ${q.dead_letter} dead-letter`);
}

async function cmdDoctor() {
  const p = await paths();
  const { loadConfig } = await config();

  // Load ~/.kiroku/.env into process.env for key detection
  const homeEnvPath = join(p.KIROKU_HOME, '.env');
  if (existsSync(homeEnvPath)) {
    for (const line of readFileSync(homeEnvPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }

  console.log(`Kiroku v${PKG_VERSION} Health Check\n`);

  // Config check (not part of shared health)
  let cfg;
  if (existsSync(p.CONFIG_PATH)) {
    try {
      cfg = loadConfig();
      console.log('  [OK] Config valid');
    } catch (err) {
      console.log(`  [!!] Config error: ${err.message}`);
    }
  } else {
    console.log('  [!!] Config not found (run `kiroku init`)');
  }

  // sqlite-vec check (not part of shared health)
  try {
    const { default: Database } = await import('better-sqlite3');
    const sqliteVec = await import('sqlite-vec');
    const db = new Database(':memory:');
    sqliteVec.load(db);
    db.close();
    console.log('  [OK] sqlite-vec extension available');
  } catch {
    console.log('  [!!] sqlite-vec not available (vector search disabled)');
  }

  // Shared health checks
  const { getSystemHealth } = await import('../src/shared/health.js');
  const health = await getSystemHealth(cfg || loadConfig());

  const db = health.components.database;
  if (db.status === 'ok') {
    console.log('  [OK] Database readable');
  } else if (db.status === 'missing') {
    console.log('  [--] Database not created yet');
  } else {
    console.log(`  [!!] Database error: ${db.error}`);
  }

  const emb = health.components.embedding_model;
  console.log(emb.cached ? '  [OK] Embedding model cached' : '  [--] Embedding model not downloaded');

  const key = health.components.extraction_key;
  if (key.set) {
    console.log(`  [OK] ${key.env_var} set`);
  } else {
    console.log(`  [!!] ${key.env_var} not set — Fix: kiroku init (or add to ~/.kiroku/.env)`);
  }

  if (db.status === 'ok' && emb.coverage_percent < 100 && db.facts > 0) {
    const missing = Math.round(db.facts * (1 - emb.coverage_percent / 100));
    console.log(`  [!!] ${missing} facts missing embeddings (run \`kiroku reindex\`)`);
  } else if (db.status === 'ok' && db.facts > 0) {
    console.log('  [OK] All facts have embeddings');
  }

  const lic = health.components.license;
  if (lic.machine_id) console.log(`  Machine ID: ${lic.machine_id}`);
  if (lic.licensed) {
    console.log(`  [OK] License valid (tier: ${lic.tier})`);
    if (lic.expiry) console.log(`       Expires: ${lic.expiry}`);
  } else {
    console.log(`  [--] Free tier`);
  }

  console.log(`\n${health.issues.length === 0 ? 'All checks passed!' : `${health.issues.length} issue(s) found.`}`);
}

async function cmdExport() {
  const p = await paths();
  const { DB_PATH, EXPORTS_DIR } = p;

  if (!existsSync(DB_PATH)) {
    console.error('Database not found. Run `kiroku init` first.');
    process.exit(1);
  }

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true });

  const projectId = args[0] || process.cwd().replace(/[\\/]/g, '-').replace(/^-/, '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const exportPath = join(EXPORTS_DIR, `kiroku-export-${projectId}-${timestamp}.md`);

  let md = `# Kiroku Memory Export\n`;
  md += `> Project: ${projectId}\n`;
  md += `> Exported: ${new Date().toLocaleString()}\n\n`;

  // Export facts
  const facts = db.prepare(`
    SELECT f.*, e.canonical_name as subject_name
    FROM facts f
    LEFT JOIN entities e ON f.subject_entity_id = e.id
    WHERE f.project_id = ? AND f.status = 'active'
    ORDER BY f.created_at DESC
  `).all(projectId);

  md += `## Active Facts (${facts.length})\n\n`;
  md += `| Subject | Predicate | Object | Type | Confidence |\n`;
  md += `|---------|-----------|--------|------|------------|\n`;
  for (const f of facts) {
    md += `| ${f.subject_name || '?'} | ${f.predicate} | ${f.object_text} | ${f.fact_type} | ${f.confidence} |\n`;
  }

  // Export entities
  const entities = db.prepare('SELECT * FROM entities ORDER BY canonical_name').all();
  md += `\n## Entities (${entities.length})\n\n`;
  for (const e of entities) {
    md += `- **${e.canonical_name}** (${e.entity_type})`;
    const aliases = JSON.parse(e.aliases_json || '[]');
    if (aliases.length > 0) md += ` — aliases: ${aliases.join(', ')}`;
    md += '\n';
  }

  db.close();

  const { mkdirSync } = await import('node:fs');
  mkdirSync(EXPORTS_DIR, { recursive: true });
  writeFileSync(exportPath, md);
  console.log(`Exported to: ${exportPath}`);
}

async function cmdReindex() {
  const p = await paths();
  const { DB_PATH } = p;

  if (!existsSync(DB_PATH)) {
    console.error('Database not found. Run `kiroku init` first.');
    process.exit(1);
  }

  const { initDb, runMigrations, isVecEnabled, closeDb } = await import('../src/shared/db.js');
  const db = await initDb();
  runMigrations();

  if (!isVecEnabled()) {
    console.error('sqlite-vec not available. Cannot reindex embeddings.');
    closeDb();
    process.exit(1);
  }

  // Find active facts without embeddings
  const facts = db.prepare(`
    SELECT f.id, f.predicate, f.object_text, f.fact_type, f.scope, f.project_id, e.canonical_name as subject
    FROM facts f
    LEFT JOIN entities e ON f.subject_entity_id = e.id
    LEFT JOIN fact_embeddings fe ON f.id = fe.fact_id
    WHERE f.status = 'active' AND fe.fact_id IS NULL
  `).all();

  if (facts.length === 0) {
    console.log('All active facts already have embeddings. Nothing to reindex.');
    closeDb();
    return;
  }

  console.log(`Found ${facts.length} facts without embeddings. Reindexing...`);

  const { loadConfig } = await config();
  const cfg = loadConfig();
  const { initEmbedder, embedTexts } = await import('../src/worker/embedder.js');

  console.log('Loading embedding model...');
  await initEmbedder(cfg.worker.embedding);

  const BATCH_SIZE = 32;
  let processed = 0;

  const stmt = db.prepare(
    `INSERT INTO fact_embeddings (fact_id, project_id, scope, fact_type, status, embedding) VALUES (?, ?, ?, ?, ?, ?)`
  );

  for (let i = 0; i < facts.length; i += BATCH_SIZE) {
    const batch = facts.slice(i, i + BATCH_SIZE);
    const texts = batch.map(f => `${f.subject || ''} ${f.predicate} ${f.object_text}`);
    const embeddings = await embedTexts(texts);

    for (let j = 0; j < batch.length; j++) {
      if (j >= embeddings.length) break;
      const f = batch[j];
      const embedding = new Float32Array(embeddings[j]);
      stmt.run(f.id, f.project_id, f.scope || 'project', f.fact_type, 'active', Buffer.from(embedding.buffer));
    }

    processed += batch.length;
    console.log(`  ${processed}/${facts.length} facts indexed`);
  }

  closeDb();
  console.log(`Done! Reindexed ${processed} facts.`);
}

async function cmdTranscript() {
  const { listSessions, listAllProjects, convertTranscript } = await import('../src/cli/transcript-converter.js');

  // Parse flags
  const isList = args.includes('--list');
  const isListAll = args.includes('--list-all');
  const isAll = args.includes('--all');
  const isView = args.includes('--view');
  const isSearch = args.includes('--search');
  const includeThinking = args.includes('--thinking');
  const noRedact = args.includes('--no-redact');
  const noPager = args.includes('--no-pager');
  const outputIdx = args.indexOf('--output');
  const output = outputIdx !== -1 ? args[outputIdx + 1] : null;
  const projectIdx = args.indexOf('--project');
  const projectFilter = projectIdx !== -1 ? args[projectIdx + 1] : null;
  const flagArgs = new Set(['--output', '--project']);
  const positional = args.filter(a => !a.startsWith('--') && !flagArgs.has(args[args.indexOf(a) - 1]));

  // --view: terminal colorized viewer
  if (isView) {
    const { viewTranscript } = await import('../src/cli/transcript-viewer.js');
    const target = positional[0];
    if (!target) {
      // Interactive: browse and pick
      const projects = listAllProjects();
      if (projects.length === 0) { console.log('No sessions found.'); return; }
      const picked = await browseProjectsWithAction(projects);
      if (picked) await viewTranscript(picked, { thinking: includeThinking, noRedact, noPager });
      return;
    }
    await viewTranscript(target, { thinking: includeThinking, noRedact, noPager });
    return;
  }

  // --search: full-text search
  if (isSearch) {
    const { searchTranscripts } = await import('../src/cli/transcript-search.js');
    const searchIdx = args.indexOf('--search');
    const query = args[searchIdx + 1];
    if (!query || query.startsWith('--')) {
      console.error('Usage: kiroku transcript --search <query> [--project <slug>]');
      process.exit(1);
    }
    searchTranscripts(query, { project: projectFilter });
    return;
  }

  if (isList) {
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log('No sessions found for current project.');
      return;
    }
    console.log('Available sessions:\n');
    for (const s of sessions) {
      const date = s.firstTimestamp ? s.firstTimestamp.slice(0, 10) : '?';
      const time = s.firstTimestamp ? s.firstTimestamp.slice(11, 16) : '';
      console.log(`  ${s.sessionId}  ${date} ${time}  (${s.lineCount} entries)`);
    }
    console.log(`\nUsage: kiroku transcript <session-id>`);
    return;
  }

  if (isListAll) {
    const projects = listAllProjects();
    if (projects.length === 0) {
      console.log('No sessions found in any project.');
      return;
    }
    // Non-TTY (piped): static output
    if (!process.stdin.isTTY) {
      for (const proj of projects) {
        console.log(`\n${proj.path} (${proj.sessions.length} sessions)`);
        for (const s of proj.sessions) {
          const date = s.firstTimestamp ? s.firstTimestamp.slice(0, 10) : '?';
          const time = s.firstTimestamp ? s.firstTimestamp.slice(11, 16) : '';
          console.log(`  ${s.sessionId}  ${date} ${time}  (${s.lineCount} entries)`);
        }
      }
      return;
    }
    // TTY: interactive browser
    await browseProjects(projects);
    return;
  }

  if (isAll) {
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log('No sessions found for current project.');
      return;
    }
    console.log(`Converting ${sessions.length} sessions...\n`);
    for (const s of sessions) {
      try {
        const result = convertTranscript(s.filePath, { thinking: includeThinking, noRedact });
        console.log(`  ${s.sessionId.slice(0, 8)} → ${result.turnCount} turns`);
      } catch (err) {
        console.log(`  ${s.sessionId.slice(0, 8)} → ERROR: ${err.message}`);
      }
    }
    console.log(`\nDone: ${sessions.length} sessions converted`);
    return;
  }

  if (positional.length === 0) {
    console.error('Usage: kiroku transcript <session-id> [--thinking] [--no-redact] [--output <path>]');
    console.error('       kiroku transcript --view [<id>]   View in terminal with colors');
    console.error('       kiroku transcript --search <q>    Full-text search');
    console.error('       kiroku transcript --list          List sessions (current project)');
    console.error('       kiroku transcript --list-all      Browse all projects');
    console.error('       kiroku transcript --all           Convert all to markdown');
    process.exit(1);
  }

  const target = positional[0];
  console.log(`Converting transcript: ${target}`);

  const result = convertTranscript(target, {
    thinking: includeThinking,
    noRedact,
    output,
  });

  console.log(`Output: ${result.outputPath} (${result.turnCount} turns)`);
}

async function cmdActivate() {
  const licenseKey = args[0];
  if (!licenseKey) {
    console.error('Usage: kiroku activate <license-key>');
    process.exit(1);
  }

  const p = await paths();
  const { getMachineId } = await import('../src/license/machine-id.js');
  const machineId = await getMachineId();

  console.log(`Activating license...`);
  console.log(`  Machine ID: ${machineId}`);

  // Call LS activate API
  const https = await import('node:https');
  const body = JSON.stringify({
    license_key: licenseKey,
    instance_name: machineId,
  });

  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.request('https://api.lemonsqueezy.com/v1/licenses/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
      req.write(body);
      req.end();
    });

    if (data.activated || data.valid) {
      // Write license key to disk
      const { mkdirSync } = await import('node:fs');
      mkdirSync(p.LICENSE_DIR, { recursive: true });
      writeFileSync(p.LICENSE_KEY_PATH, licenseKey);

      // Save instance ID for deactivation
      if (data.instance?.id) {
        writeFileSync(p.OFFLINE_LICENSE_PATH, JSON.stringify({
          licensed: true,
          tier: 'pro',
          instanceId: data.instance.id,
          validatedAt: Date.now(),
        }));
      }

      // Reset license cache
      const { resetLicenseCache } = await import('../src/license/license-state.js');
      resetLicenseCache();

      console.log(`  Activated: pro tier`);
      if (data.instance) {
        console.log(`  Instance ID: ${data.instance.id}`);
      }

      // Test prompt fetch
      console.log('  Testing premium prompt access...');
      const { initPromptLoader, getPrompt, stopPromptLoader } = await import('../src/worker/prompt-loader.js');
      await initPromptLoader();
      const prompt = getPrompt();
      stopPromptLoader();
      console.log(`  Prompt: ${prompt ? 'OK' : 'using basic fallback'} (${prompt.length} chars)`);
    } else {
      console.error(`  Activation failed: ${data.error || JSON.stringify(data)}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`  Activation error: ${err.message}`);
    process.exit(1);
  }
}

async function cmdDeactivate() {
  const p = await paths();

  if (!existsSync(p.LICENSE_KEY_PATH)) {
    console.log('No active license found.');
    return;
  }

  const licenseKey = readFileSync(p.LICENSE_KEY_PATH, 'utf8').trim();
  console.log('Deactivating license...');

  // Read offline state for instance_id
  let instanceId;
  try {
    if (existsSync(p.OFFLINE_LICENSE_PATH)) {
      const offline = JSON.parse(readFileSync(p.OFFLINE_LICENSE_PATH, 'utf8'));
      instanceId = offline.instanceId;
    }
  } catch { /* ignore */ }

  // Call LS deactivate API
  const https = await import('node:https');
  const body = JSON.stringify({
    license_key: licenseKey,
    instance_id: instanceId || 'unknown',
  });

  try {
    await new Promise((resolve, reject) => {
      const req = https.request('https://api.lemonsqueezy.com/v1/licenses/deactivate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.log(`  Warning: LS deactivate call failed (${err.message}), continuing local cleanup`);
  }

  // Clean up local files
  try { unlinkSync(p.LICENSE_KEY_PATH); } catch {}
  try { unlinkSync(p.PROMPT_CACHE_PATH); } catch {}
  try { unlinkSync(p.OFFLINE_LICENSE_PATH); } catch {}

  const { resetLicenseCache } = await import('../src/license/license-state.js');
  resetLicenseCache();

  console.log('  Deactivated, reverted to free tier');
}

async function cmdLicense() {
  const p = await paths();

  if (!existsSync(p.LICENSE_KEY_PATH)) {
    console.log('No license key found. Run `kiroku activate <key>` to activate.');
    const { getMachineId } = await import('../src/license/machine-id.js');
    const machineId = await getMachineId();
    console.log(`Machine ID: ${machineId}`);
    return;
  }

  const { getLicenseState, resetLicenseCache } = await import('../src/license/license-state.js');
  resetLicenseCache(); // Force fresh validation
  const state = await getLicenseState();

  console.log(`Tier:       ${state.tier}`);
  console.log(`Licensed:   ${state.licensed}`);
  console.log(`Machine ID: ${state.machineId}`);
  if (state.expiry) console.log(`Expires:    ${state.expiry.toISOString()}`);
  console.log(`Embedding:  ${state.embeddingEnabled ? 'enabled' : 'disabled'}`);
}

async function cmdHookOnStop() {
  const p = await paths();
  const workerState = getWorkerState(p);
  if (!workerState) {
    // Worker not running, nothing to do
    return;
  }
  try {
    process.kill(workerState.pid, 'SIGUSR1');
  } catch {
    // Worker gone, ignore
  }
}

function cmdHelp() {
  console.log(`Kiroku v${PKG_VERSION} - AI Memory Gateway

Usage: kiroku <command> [options]

Commands:
  init          Initialize ~/.kiroku/ and database
  start         Start proxy + worker + MCP, launch Claude
  stop          Stop all background processes
  status        Show system status
  doctor        Health check
  export        Export memory to markdown
  reindex       Rebuild missing embeddings (after migration or vec rebuild)
  transcript    View, search, or convert session transcripts
  rec           Record a Claude session (script/asciinema)
  play          Replay a recording
  recs          List recordings
  activate      Activate a license key
  deactivate    Deactivate current license
  license       Show license status
  hook-on-stop  (Internal) Trigger worker immediate poll via SIGUSR1

Transcript options:
  kiroku transcript --view [<id>]         View in terminal with ANSI colors
  kiroku transcript --search <query>      Full-text search across all sessions
  kiroku transcript --list                List sessions (current project)
  kiroku transcript --list-all            Browse all projects (interactive)
  kiroku transcript <id>                  Convert session to markdown
  kiroku transcript <id> --thinking       Include thinking blocks
  kiroku transcript <id> --no-redact      Skip DLP redaction
  kiroku transcript --all                 Convert all sessions

Recording options:
  kiroku rec                              Record session (auto-detect backend)
  kiroku play <file>                      Replay a recording
  kiroku recs                             List all recordings

Examples:
  kiroku init            # First-time setup
  kiroku start           # Launch with memory enabled
  kiroku status          # Check what's running
  kiroku stop            # Shut everything down
  kiroku export my-proj  # Export project memory
  kiroku reindex         # Rebuild embeddings after vec table rebuild`);
}

// ─── Helpers ──────────────────────────────────────────

async function startProxyDaemon(p) {
  const daemonScript = USE_DIST
    ? join(ROOT, 'dist', 'proxy.cjs')
    : join(ROOT, 'src', 'proxy', 'server.js');

  // We spawn the proxy as a detached process
  const child = spawn(process.execPath, [
    ...resolveEnvFileArgs(),
    daemonScript,
  ], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, KIROKU_DAEMON: '1', KIROKU_ROOT: ROOT },
  });
  child.unref();

  // Wait for state file to appear
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const state = await getProxyState(p);
    if (state) {
      console.log(`  Proxy started (port ${state.port}, PID ${state.pid})`);
      return state;
    }
  }
  throw new Error('Proxy startup timeout');
}

async function startWorkerDaemon(p) {
  const workerScript = USE_DIST
    ? join(ROOT, 'dist', 'worker.cjs')
    : join(ROOT, 'src', 'worker', 'worker.js');
  const child = spawn(process.execPath, [
    ...resolveEnvFileArgs(),
    workerScript,
  ], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, KIROKU_DAEMON: '1', KIROKU_ROOT: ROOT },
  });
  child.unref();

  // Wait for state file
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const state = getWorkerState(p);
    if (state) {
      console.log(`  Worker started (PID ${state.pid})`);
      return state;
    }
  }
  console.log('  Worker start timed out (will retry on next start)');
}

async function browseProjects(projects) {
  const { emitKeypressEvents } = await import('node:readline');
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let mode = 'projects'; // 'projects' | 'sessions'
  let cursor = 0;
  let sessionCursor = 0;
  let currentProject = null;

  const rows = () => process.stdout.rows || 24;
  const cols = () => process.stdout.columns || 80;

  function render() {
    process.stdout.write('\x1b[2J\x1b[H'); // clear screen

    if (mode === 'projects') {
      const header = ' Projects  (↑↓ navigate · Enter expand · q quit)';
      console.log(`\x1b[7m${header.padEnd(cols())}\x1b[0m\n`);
      const maxVisible = rows() - 4;
      const start = Math.max(0, cursor - maxVisible + 2);
      const end = Math.min(projects.length, start + maxVisible);
      for (let i = start; i < end; i++) {
        const p = projects[i];
        const latest = p.sessions[0]?.lastTimestamp?.slice(0, 10) || '?';
        const line = `  ${p.path}  (${p.sessions.length} sessions, latest: ${latest})`;
        if (i === cursor) {
          console.log(`\x1b[36m❯ ${line}\x1b[0m`);
        } else {
          console.log(`  ${line}`);
        }
      }
    } else {
      const proj = currentProject;
      const header = ` ${proj.path}  (← back · ↑↓ navigate · q quit)`;
      console.log(`\x1b[7m${header.padEnd(cols())}\x1b[0m\n`);
      const maxVisible = rows() - 4;
      const start = Math.max(0, sessionCursor - maxVisible + 2);
      const end = Math.min(proj.sessions.length, start + maxVisible);
      for (let i = start; i < end; i++) {
        const s = proj.sessions[i];
        const date = s.firstTimestamp ? s.firstTimestamp.slice(0, 10) : '?';
        const time = s.firstTimestamp ? s.firstTimestamp.slice(11, 16) : '';
        const line = `  ${s.sessionId}  ${date} ${time}  (${s.lineCount} entries)`;
        if (i === sessionCursor) {
          console.log(`\x1b[33m❯ ${line}\x1b[0m`);
        } else {
          console.log(`  ${line}`);
        }
      }
    }
  }

  function cleanup() {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[2J\x1b[H');
  }

  return new Promise((resolve) => {
    render();

    process.stdin.on('keypress', (str, key) => {
      if (!key) return;

      // Quit
      if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve();
        return;
      }

      if (mode === 'projects') {
        if (key.name === 'up' || key.name === 'k') {
          cursor = Math.max(0, cursor - 1);
        } else if (key.name === 'down' || key.name === 'j') {
          cursor = Math.min(projects.length - 1, cursor + 1);
        } else if (key.name === 'return' || key.name === 'right' || key.name === 'l') {
          currentProject = projects[cursor];
          sessionCursor = 0;
          mode = 'sessions';
        }
      } else {
        if (key.name === 'up' || key.name === 'k') {
          sessionCursor = Math.max(0, sessionCursor - 1);
        } else if (key.name === 'down' || key.name === 'j') {
          sessionCursor = Math.min(currentProject.sessions.length - 1, sessionCursor + 1);
        } else if (key.name === 'left' || key.name === 'h' || key.name === 'backspace') {
          mode = 'projects';
        } else if (key.name === 'return') {
          // Copy session ID to stdout for easy use
          cleanup();
          const s = currentProject.sessions[sessionCursor];
          console.log(`Session: ${s.sessionId}`);
          console.log(`  Path: ${s.filePath}`);
          const date = s.firstTimestamp ? s.firstTimestamp.slice(0, 10) : '?';
          const time = s.firstTimestamp ? s.firstTimestamp.slice(11, 16) : '';
          console.log(`  Date: ${date} ${time}`);
          console.log(`  Entries: ${s.lineCount}`);
          console.log(`\nConvert: kiroku transcript ${s.filePath}`);
          resolve();
          return;
        }
      }
      render();
    });
  });
}

async function getProxyState(p) {
  if (!existsSync(p.PROXY_STATE_PATH)) return null;
  try {
    const state = JSON.parse(readFileSync(p.PROXY_STATE_PATH, 'utf8'));
    // Verify proxy is actually alive
    const alive = await httpGet(`http://127.0.0.1:${state.port}/health?secret=${state.secret}`);
    return alive === 'KIROKU_OK' ? state : null;
  } catch {
    return null;
  }
}

function getWorkerState(p) {
  if (!existsSync(p.WORKER_STATE_PATH)) return null;
  try {
    const state = JSON.parse(readFileSync(p.WORKER_STATE_PATH, 'utf8'));
    return isProcessAlive(state.pid) ? state : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Atomic lock via O_EXCL — returns true if acquired, false if held by another live process
function acquireStartupLock(lockPath) {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    // Lock file exists — check if holder is still alive (stale lock cleanup)
    try {
      const holderPid = parseInt(readFileSync(lockPath, 'utf8'));
      if (!isProcessAlive(holderPid)) {
        try { unlinkSync(lockPath); } catch {}
        writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        return true;
      }
    } catch {}
    return false;
  }
}

async function waitForProxyState(p, maxRetries = 20) {
  for (let i = 0; i < maxRetries; i++) {
    await sleep(500);
    const state = await getProxyState(p);
    if (state) return state;
  }
  return null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function resolveEnvFileArgs() {
  const homeEnv = join(homedir(), '.kiroku', '.env');
  const rootEnv = join(ROOT, '.env');
  const args = [];
  if (existsSync(rootEnv)) args.push('--env-file=' + rootEnv);
  if (existsSync(homeEnv)) args.push('--env-file=' + homeEnv); // latter overrides former
  return args;
}

function askQuestion(rl, prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

async function interactiveProviderSetup() {
  const { loadConfig, resetConfigCache } = await config();
  const cfg = loadConfig();
  const ext = cfg.worker.extraction;

  // Check if already configured (re-init)
  const homeEnv = join(homedir(), '.kiroku', '.env');
  const hasKey = existsSync(homeEnv) && readFileSync(homeEnv, 'utf8').trim().length > 0;
  if (hasKey && ext.provider) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await askQuestion(rl, `\n  Already configured [${ext.provider}]. Reconfigure? [y/N]: `);
    rl.close();
    if (!answer.match(/^y(es)?$/i)) return;
  }

  console.log(`
── Extraction Provider Setup ──────────────────────────────

Kiroku uses an LLM to extract knowledge from conversations.

  1) OpenRouter    — cloud, 200+ models (recommended)
  2) OpenAI-compat — OpenAI, Groq, Together, etc.
  3) Google Gemini — direct Gemini API
  4) Anthropic     — direct Claude API
  5) Ollama        — local, free, no API key
`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const choice = (await askQuestion(rl, '  Provider [1-5, default 1]: ')).trim() || '1';

  let provider, model, baseUrl, apiKeyEnv, apiKeyValue;

  switch (choice) {
    case '1': {
      provider = 'openrouter';
      apiKeyEnv = 'OPENROUTER_API_KEY';
      console.log('\n  Get a free key at: https://openrouter.ai/keys');
      apiKeyValue = (await askQuestion(rl, '  API key: ')).trim();
      model = (await askQuestion(rl, '  Model [google/gemini-2.0-flash-001]: ')).trim() || 'google/gemini-2.0-flash-001';
      break;
    }
    case '2': {
      provider = 'openai-compatible';
      apiKeyEnv = 'OPENAI_API_KEY';
      baseUrl = (await askQuestion(rl, '\n  Base URL (e.g. https://api.openai.com/v1): ')).trim();
      apiKeyValue = (await askQuestion(rl, '  API key: ')).trim();
      model = (await askQuestion(rl, '  Model (e.g. gpt-4o-mini): ')).trim();
      if (!baseUrl) { rl.close(); console.log('  Skipped (no base URL).'); return; }
      if (!model) { rl.close(); console.log('  Skipped (no model).'); return; }
      break;
    }
    case '3': {
      provider = 'gemini';
      apiKeyEnv = 'GEMINI_API_KEY';
      console.log('\n  Get a key at: https://aistudio.google.com/apikey');
      apiKeyValue = (await askQuestion(rl, '  API key: ')).trim();
      model = (await askQuestion(rl, '  Model [gemini-2.0-flash]: ')).trim() || 'gemini-2.0-flash';
      break;
    }
    case '4': {
      provider = 'anthropic';
      apiKeyEnv = 'ANTHROPIC_EXTRACTION_KEY';
      console.log('\n  Get a key at: https://console.anthropic.com/settings/keys');
      apiKeyValue = (await askQuestion(rl, '  API key: ')).trim();
      model = (await askQuestion(rl, '  Model [claude-haiku-4-5-20251001]: ')).trim() || 'claude-haiku-4-5-20251001';
      break;
    }
    case '5': {
      provider = 'ollama';
      apiKeyEnv = 'OPENROUTER_API_KEY'; // unused but schema requires it
      baseUrl = (await askQuestion(rl, '\n  Base URL [http://127.0.0.1:11434]: ')).trim() || 'http://127.0.0.1:11434';
      model = (await askQuestion(rl, '  Model [qwen2.5:14b-instruct-q4_K_M]: ')).trim() || 'qwen2.5:14b-instruct-q4_K_M';
      break;
    }
    default: {
      rl.close();
      console.log('  Invalid choice, skipped.');
      return;
    }
  }

  rl.close();

  // Write API key to ~/.kiroku/.env
  if (apiKeyValue && provider !== 'ollama') {
    const envPath = join(homedir(), '.kiroku', '.env');
    // Read existing .env and merge
    let envLines = [];
    if (existsSync(envPath)) {
      envLines = readFileSync(envPath, 'utf8').split('\n').filter(l => !l.startsWith(apiKeyEnv + '='));
    }
    envLines.push(`${apiKeyEnv}=${apiKeyValue}`);
    writeFileSync(envPath, envLines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
    chmodSync(envPath, 0o600); // ensure permissions even if file existed
    console.log(`  Saved ${apiKeyEnv} to ~/.kiroku/.env`);
  } else if (!apiKeyValue && provider !== 'ollama') {
    console.log(`  No key entered. Add manually: echo "${apiKeyEnv}=your-key" >> ~/.kiroku/.env`);
  }

  // Update config.json with provider/model/baseUrl
  const { CONFIG_PATH } = await paths();
  let rawCfg = {};
  if (existsSync(CONFIG_PATH)) {
    try { rawCfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  }
  if (!rawCfg.worker) rawCfg.worker = {};
  if (!rawCfg.worker.extraction) rawCfg.worker.extraction = {};
  rawCfg.worker.extraction.provider = provider;
  rawCfg.worker.extraction.model = model;
  rawCfg.worker.extraction.apiKeyEnv = apiKeyEnv;
  if (baseUrl) {
    rawCfg.worker.extraction.baseUrl = baseUrl;
  } else {
    delete rawCfg.worker.extraction.baseUrl;
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(rawCfg, null, 2) + '\n');
  resetConfigCache();
  console.log(`  Updated config: provider=${provider}, model=${model}`);
}

async function browseProjectsWithAction(projects) {
  const { emitKeypressEvents } = await import('node:readline');
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let mode = 'projects'; // 'projects' | 'sessions' | 'action'
  let cursor = 0;
  let sessionCursor = 0;
  let currentProject = null;

  const rows = () => process.stdout.rows || 24;
  const cols = () => process.stdout.columns || 80;

  function render() {
    process.stdout.write('\x1b[2J\x1b[H');

    if (mode === 'projects') {
      const header = ' Projects  (↑↓ navigate · Enter expand · q quit)';
      console.log(`\x1b[7m${header.padEnd(cols())}\x1b[0m\n`);
      const maxVisible = rows() - 4;
      const start = Math.max(0, cursor - maxVisible + 2);
      const end = Math.min(projects.length, start + maxVisible);
      for (let i = start; i < end; i++) {
        const p = projects[i];
        const latest = p.sessions[0]?.lastTimestamp?.slice(0, 10) || '?';
        const line = `  ${p.path}  (${p.sessions.length} sessions, latest: ${latest})`;
        console.log(i === cursor ? `\x1b[36m❯ ${line}\x1b[0m` : `  ${line}`);
      }
    } else if (mode === 'sessions') {
      const proj = currentProject;
      const header = ` ${proj.path}  (← back · Enter select · v view · q quit)`;
      console.log(`\x1b[7m${header.padEnd(cols())}\x1b[0m\n`);
      const maxVisible = rows() - 4;
      const start = Math.max(0, sessionCursor - maxVisible + 2);
      const end = Math.min(proj.sessions.length, start + maxVisible);
      for (let i = start; i < end; i++) {
        const s = proj.sessions[i];
        const date = s.firstTimestamp ? s.firstTimestamp.slice(0, 10) : '?';
        const time = s.firstTimestamp ? s.firstTimestamp.slice(11, 16) : '';
        const line = `  ${s.sessionId.slice(0, 8)}  ${date} ${time}  (${s.lineCount} entries)`;
        console.log(i === sessionCursor ? `\x1b[33m❯ ${line}\x1b[0m` : `  ${line}`);
      }
    }
  }

  function cleanup() {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\x1b[2J\x1b[H');
  }

  return new Promise((resolve) => {
    render();

    process.stdin.on('keypress', (str, key) => {
      if (!key) return;

      if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve(null);
        return;
      }

      if (mode === 'projects') {
        if (key.name === 'up' || key.name === 'k') cursor = Math.max(0, cursor - 1);
        else if (key.name === 'down' || key.name === 'j') cursor = Math.min(projects.length - 1, cursor + 1);
        else if (key.name === 'return' || key.name === 'right' || key.name === 'l') {
          currentProject = projects[cursor];
          sessionCursor = 0;
          mode = 'sessions';
        }
      } else if (mode === 'sessions') {
        if (key.name === 'up' || key.name === 'k') sessionCursor = Math.max(0, sessionCursor - 1);
        else if (key.name === 'down' || key.name === 'j') sessionCursor = Math.min(currentProject.sessions.length - 1, sessionCursor + 1);
        else if (key.name === 'left' || key.name === 'h' || key.name === 'backspace') mode = 'projects';
        else if (key.name === 'return' || str === 'v') {
          cleanup();
          resolve(currentProject.sessions[sessionCursor].filePath);
          return;
        }
      }
      render();
    });
  });
}

// ─── Recording Commands ──────────────────────────────

async function cmdRec() {
  const p = await paths();
  const { RECORDINGS_DIR } = p;

  mkdirSync(RECORDINGS_DIR, { recursive: true });

  const backend = detectRecBackend();
  const projectSlug = process.cwd().replace(/[\\/]/g, '-').replace(/^-/, '').split('-').slice(-2).join('-');
  const shortId = Math.random().toString(36).slice(2, 8);
  const date = new Date().toISOString().slice(0, 10);
  const ext = backend === 'asciinema' ? '.cast' : '.typescript';
  const recPath = join(RECORDINGS_DIR, `${date}-${projectSlug}-${shortId}${ext}`);

  // Determine claude args (pass through everything after 'rec')
  const claudeArgs = args.filter(a => a !== '--backend' && a !== 'asciinema' && a !== 'script');
  const claudeCmd = `claude ${claudeArgs.join(' ')}`.trim();

  console.log(`Recording: ${recPath}`);
  console.log(`Backend:   ${backend}`);
  console.log(`Command:   ${claudeCmd}\n`);

  if (backend === 'asciinema') {
    const child = spawn('asciinema', ['rec', '--title', `kiroku ${projectSlug}`, '--command', claudeCmd, recPath], {
      stdio: 'inherit',
      shell: true,
    });
    child.on('exit', (code) => {
      console.log(`\nRecording saved: ${recPath}`);
      console.log(`Replay: kiroku play ${recPath}`);
      process.exit(code || 0);
    });
  } else {
    // macOS script -q -r <timing-file> <output-file> <command>
    const child = spawn('script', ['-q', recPath, '/bin/zsh', '-c', claudeCmd], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      console.log(`\nRecording saved: ${recPath}`);
      console.log(`Replay: kiroku play ${recPath}`);
      process.exit(code || 0);
    });
  }
}

async function cmdPlay() {
  const recPath = args[0];
  if (!recPath) {
    console.error('Usage: kiroku play <recording-file>');
    console.error('       kiroku recs    (list recordings)');
    process.exit(1);
  }

  if (!existsSync(recPath)) {
    // Try from RECORDINGS_DIR
    const p = await paths();
    const fullPath = join(p.RECORDINGS_DIR, recPath);
    if (!existsSync(fullPath)) {
      console.error(`Recording not found: ${recPath}`);
      process.exit(1);
    }
    args[0] = fullPath;
  }

  const target = args[0];
  if (target.endsWith('.cast')) {
    const child = spawn('asciinema', ['play', target], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
    child.on('error', () => {
      console.error('asciinema not installed. Install: brew install asciinema');
      process.exit(1);
    });
  } else {
    // macOS: cat the typescript file (script -p is for BSD playback)
    const child = spawn('cat', [target], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code || 0));
  }
}

async function cmdRecs() {
  const p = await paths();
  const { RECORDINGS_DIR } = p;

  if (!existsSync(RECORDINGS_DIR)) {
    console.log('No recordings found. Use `kiroku rec` to start recording.');
    return;
  }

  const files = readdirSync(RECORDINGS_DIR)
    .filter(f => f.endsWith('.typescript') || f.endsWith('.cast'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log('No recordings found. Use `kiroku rec` to start recording.');
    return;
  }

  console.log(`Recordings (${files.length}):\n`);
  for (const f of files) {
    const fullPath = join(RECORDINGS_DIR, f);
    const stat = statSync(fullPath);
    const sizeKB = Math.round(stat.size / 1024);
    const backend = f.endsWith('.cast') ? 'asciinema' : 'script';
    console.log(`  ${f}  (${sizeKB} KB, ${backend})`);
  }
  console.log(`\nReplay: kiroku play <file>`);
}

function detectRecBackend() {
  const forceBackend = args.find((a, i) => args[i - 1] === '--backend');
  if (forceBackend) return forceBackend;
  try {
    execSync('which asciinema', { stdio: 'ignore' });
    return 'asciinema';
  } catch {
    return 'script';
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
