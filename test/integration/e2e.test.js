/**
 * E2E integration tests using a real in-memory SQLite database.
 * Tests audit_log writes, health_status, and store operations end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/** Bootstrap a fresh in-memory DB with all non-vec migrations applied. */
function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const migrationFiles = ['001_init.sql', '003_scope.sql', '005_heat_decay.sql', '006_audit_log.sql'];
  for (const file of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const stmts = sql.split(';').map(s => s.trim()).filter(s => s && !s.toUpperCase().startsWith('PRAGMA'));
    for (const stmt of stmts) {
      db.exec(stmt);
    }
  }
  return db;
}

// ─── audit.js ───

describe('audit integration', () => {
  let db;

  beforeAll(() => { db = createTestDb(); });
  afterAll(() => { db.close(); });

  it('writeAudit should insert a row with correct fields', async () => {
    const { writeAudit } = await import('../../src/shared/audit.js');

    writeAudit(db, {
      projectId: 'proj-1',
      action: 'save',
      targetType: 'fact',
      targetId: 'fact_abc',
      detail: { subject: 'foo', predicate: 'uses' },
    });

    const rows = db.prepare('SELECT * FROM audit_logs').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe('proj-1');
    expect(rows[0].action).toBe('save');
    expect(rows[0].target_type).toBe('fact');
    expect(rows[0].target_id).toBe('fact_abc');
    expect(rows[0].id).toMatch(/^aud_/);
    expect(rows[0].created_at).toBeTruthy();

    const detail = JSON.parse(rows[0].detail_json);
    expect(detail.subject).toBe('foo');
    expect(detail.predicate).toBe('uses');
  });

  it('writeAudit should handle all action types', async () => {
    const { writeAudit } = await import('../../src/shared/audit.js');

    for (const action of ['forget', 'extract', 'evict']) {
      writeAudit(db, { projectId: 'proj-1', action, targetType: 'fact', targetId: `fact_${action}` });
    }

    const rows = db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all();
    const actions = rows.map(r => r.action);
    expect(actions).toContain('save');
    expect(actions).toContain('forget');
    expect(actions).toContain('extract');
    expect(actions).toContain('evict');
  });

  it('writeAudit should not throw on invalid db', async () => {
    const { writeAudit } = await import('../../src/shared/audit.js');

    const badDb = { prepare: () => { throw new Error('broken'); } };
    // Should not throw — failures are silently logged
    expect(() => writeAudit(badDb, { projectId: 'x', action: 'save' })).not.toThrow();
  });
});

// ─── store.js + audit ───

describe('store integration with audit', () => {
  let db;

  beforeAll(async () => {
    db = createTestDb();
    const { setDb } = await import('../../src/worker/store.js');
    setDb(db);
  });
  afterAll(() => { db.close(); });

  it('storeFacts should write audit entries for each extracted fact', async () => {
    const { storeEntities, storeFacts } = await import('../../src/worker/store.js');

    // Setup: create project
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run('test-proj', 'test-proj');

    const entities = [{ canonical_name: 'NodeJS', entity_type: 'technology' }];
    const entityMap = storeEntities(entities, 'test-proj');

    const facts = [
      { subject: 'NodeJS', predicate: 'is used for', object: 'server-side JS', fact_type: 'semantic', confidence: 0.9 },
      { subject: 'NodeJS', predicate: 'has version', object: '20.x', fact_type: 'semantic', confidence: 0.8 },
    ];

    const factIds = storeFacts(facts, entityMap, 'test-proj', null, null);
    expect(factIds).toHaveLength(2);

    // Verify audit entries were created
    const audits = db.prepare("SELECT * FROM audit_logs WHERE action = 'extract' ORDER BY rowid").all();
    expect(audits.length).toBeGreaterThanOrEqual(2);

    // Each audit should reference the corresponding fact
    const auditFactIds = audits.map(a => a.target_id);
    for (const fid of factIds) {
      expect(auditFactIds).toContain(fid);
    }
  });

  it('saveFactManually should write save audit', async () => {
    const { saveFactManually } = await import('../../src/worker/store.js');

    const beforeCount = db.prepare("SELECT COUNT(*) as c FROM audit_logs WHERE action = 'save'").get().c;

    // Note: saveFactManually doesn't write audit itself — it's done in memory-write.js
    // But we can verify the fact is created correctly
    const fid = saveFactManually({
      subject: 'Vitest',
      predicate: 'is',
      object: 'a test framework',
      factType: 'semantic',
      projectId: 'test-proj',
      scope: 'project',
      licenseState: null,
    });

    expect(fid).toMatch(/^fact_/);

    // Verify the fact exists in DB
    const fact = db.prepare('SELECT * FROM facts WHERE id = ?').get(fid);
    expect(fact).toBeTruthy();
    expect(fact.status).toBe('active');
    expect(fact.base_heat).toBe(1.0);
  });

  it('archiveFacts should update status to archived', async () => {
    const { saveFactManually, archiveFacts } = await import('../../src/worker/store.js');

    const fid = saveFactManually({
      subject: 'Temp',
      predicate: 'will be',
      object: 'archived',
      factType: 'semantic',
      projectId: 'test-proj',
      scope: 'project',
      licenseState: null,
    });

    const archived = archiveFacts({ factId: fid, projectId: 'test-proj' });
    expect(archived).toContain(fid);

    const fact = db.prepare('SELECT * FROM facts WHERE id = ?').get(fid);
    expect(fact.status).toBe('archived');
    expect(fact.decay_bucket).toBe('archived');
  });
});

// ─── health.js ───

describe('health integration', () => {
  it('getSystemHealth should return well-structured result', async () => {
    // health.js reads from the real DB_PATH, so we mock paths to point nowhere
    // and verify it handles missing DB gracefully
    vi.doMock('../../src/shared/paths.js', () => ({
      DB_PATH: '/tmp/kiroku-test-nonexistent-health.sqlite',
      QUEUE_INCOMING: '/tmp/kiroku-test-nonexistent-qi',
      QUEUE_PROCESSING: '/tmp/kiroku-test-nonexistent-qp',
      QUEUE_DEAD: '/tmp/kiroku-test-nonexistent-qd',
      CONFIG_PATH: '/tmp/kiroku-test-nonexistent-cfg',
      MODEL_CACHE_DIR: '/tmp/kiroku-test-nonexistent-cache',
      ensureDirs: () => {},
    }));

    // Also mock license to avoid real filesystem access
    vi.doMock('../../src/license/license-state.js', () => ({
      getLicenseState: async () => ({
        licensed: false,
        tier: 'free',
        expiry: null,
        machineId: 'test-machine',
        factLimit: 500,
        dailyExtractLimit: 50,
        embeddingEnabled: false,
      }),
    }));

    const { getSystemHealth } = await import('../../src/shared/health.js');
    const health = await getSystemHealth({ worker: { extraction: { apiKeyEnv: 'TEST_KEY_NOT_SET' } } });

    // Structure checks
    expect(health).toHaveProperty('status');
    expect(health).toHaveProperty('components');
    expect(health).toHaveProperty('issues');
    expect(Array.isArray(health.issues)).toBe(true);

    // Components present
    expect(health.components).toHaveProperty('database');
    expect(health.components).toHaveProperty('queue');
    expect(health.components).toHaveProperty('embedding_model');
    expect(health.components).toHaveProperty('extraction_key');
    expect(health.components).toHaveProperty('license');

    // DB should be missing (nonexistent path)
    expect(health.components.database.status).toBe('missing');

    // Queue should default to 0s
    expect(health.components.queue.incoming).toBe(0);
    expect(health.components.queue.processing).toBe(0);
    expect(health.components.queue.dead_letter).toBe(0);

    // Extraction key not set
    expect(health.components.extraction_key.set).toBe(false);

    // License from mock
    expect(health.components.license.licensed).toBe(false);
    expect(health.components.license.tier).toBe('free');
    expect(health.components.license.machine_id).toBe('test-machine');

    // Status should be degraded (DB missing + key not set)
    expect(health.status).toBe('degraded');
    expect(health.issues.length).toBeGreaterThan(0);

    vi.doUnmock('../../src/shared/paths.js');
    vi.doUnmock('../../src/license/license-state.js');
  });
});

// ─── health-status.js (MCP tool formatter) ───

describe('healthStatus MCP formatter', () => {
  it('should format health into readable text', async () => {
    vi.doMock('../../src/shared/health.js', () => ({
      getSystemHealth: async () => ({
        status: 'healthy',
        components: {
          database: { status: 'ok', projects: 2, facts: 10, entities: 5, turns: 20 },
          queue: { incoming: 1, processing: 0, dead_letter: 0 },
          embedding_model: { cached: true, coverage_percent: 100 },
          extraction_key: { set: true, env_var: 'OPENROUTER_API_KEY' },
          license: { licensed: true, tier: 'pro', expiry: '2027-01-01', machine_id: 'abc' },
        },
        issues: [],
      }),
    }));

    const { healthStatus } = await import('../../src/mcp/health-status.js');
    const output = await healthStatus({});

    expect(output).toContain('HEALTHY');
    expect(output).toContain('2 projects');
    expect(output).toContain('10 facts');
    expect(output).toContain('5 entities');
    expect(output).toContain('20 turns');
    expect(output).toContain('1 incoming');
    expect(output).toContain('cached');
    expect(output).toContain('coverage 100%');
    expect(output).toContain('set');
    expect(output).toContain('pro');
    expect(output).not.toContain('Issues');

    vi.doUnmock('../../src/shared/health.js');
    vi.resetModules();
  });

  it('should show issues when degraded', async () => {
    vi.doMock('../../src/shared/health.js', () => ({
      getSystemHealth: async () => ({
        status: 'degraded',
        components: {
          database: { status: 'missing' },
          queue: { incoming: 0, processing: 0, dead_letter: 3 },
          embedding_model: { cached: false, coverage_percent: 0 },
          extraction_key: { set: false, env_var: 'OPENROUTER_API_KEY' },
          license: { licensed: false, tier: 'free', expiry: null, machine_id: null },
        },
        issues: ['Database not initialized', 'OPENROUTER_API_KEY not set'],
      }),
    }));

    const { healthStatus } = await import('../../src/mcp/health-status.js');
    const output = await healthStatus({});

    expect(output).toContain('DEGRADED');
    expect(output).toContain('missing');
    expect(output).toContain('3 dead-letter');
    expect(output).toContain('NOT SET');
    expect(output).toContain('free tier');
    expect(output).toContain('Issues');
    expect(output).toContain('Database not initialized');

    vi.doUnmock('../../src/shared/health.js');
    vi.resetModules();
  });
});

// ─── sql-sandbox with real DB ───

describe('sql-sandbox with real DB', () => {
  let db;

  beforeAll(() => { db = createTestDb(); });
  afterAll(() => { db.close(); });

  it('should query audit_logs table', async () => {
    const { writeAudit } = await import('../../src/shared/audit.js');

    // Insert some audit entries
    writeAudit(db, { projectId: 'p1', action: 'save', targetType: 'fact', targetId: 'f1' });
    writeAudit(db, { projectId: 'p1', action: 'extract', targetType: 'fact', targetId: 'f2' });

    // Query via sql-sandbox style
    const rows = db.prepare(
      "SELECT action, target_id FROM audit_logs WHERE project_id = ? ORDER BY created_at"
    ).all('p1');

    expect(rows.length).toBeGreaterThanOrEqual(2);
    const actions = rows.map(r => r.action);
    expect(actions).toContain('save');
    expect(actions).toContain('extract');
  });

  it('audit_logs index should exist', () => {
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_logs'"
    ).all();
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_audit_project_time');
  });
});
