import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const PROJECT_ID = 'exact-gate-project';
// Non-vec harness: the exact path is the free tier's only mutation mechanism,
// so it is tested without embeddings on purpose.
const MIGRATION_FILES = [
  '001_init.sql',
  '003_scope.sql',
  '005_heat_decay.sql',
  '006_audit_log.sql',
  '007_v12_enhancements.sql',
  '008_content_dedup_index.sql',
  '009_repo_grounding.sql',
];

const dbState = vi.hoisted(() => ({ db: null }));

vi.mock('../../src/shared/db.js', () => ({
  getDb: () => dbState.db,
  isVecEnabled: () => false,
}));

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

const { setDb, storeEntities, storeFacts } = await import('../../src/worker/store.js');

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of sql.split(';').map(s => s.trim()).filter(s => s && !s.toUpperCase().startsWith('PRAGMA'))) {
      db.exec(statement);
    }
  }
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(PROJECT_ID, PROJECT_ID);
  return db;
}

function addFact({ subject, predicate, object, factType = 'semantic', scope = 'project' }) {
  const entityMap = storeEntities([{ canonical_name: subject, entity_type: 'concept' }], PROJECT_ID);
  const [fid] = storeFacts(
    [{ subject, predicate, object, fact_type: factType, confidence: 1, scope }],
    entityMap, PROJECT_ID, null, null,
  );
  return fid;
}

function factRow(id) {
  return dbState.db.prepare('SELECT status, decay_bucket FROM facts WHERE id = ?').get(id);
}

function exactAudits() {
  return dbState.db.prepare("SELECT target_id, detail_json FROM audit_logs WHERE action = 'exact_supersede'")
    .all()
    .map(row => ({ targetId: row.target_id, detail: JSON.parse(row.detail_json) }));
}

describe('exact supersede gate (G13)', () => {
  beforeEach(() => {
    dbState.db = createDb();
    setDb(dbState.db);
  });

  it('preference: same subject+predicate supersedes the old value and writes an audit row', () => {
    const oldId = addFact({ subject: 'User', predicate: 'prefers editor', object: 'vim', factType: 'preference', scope: 'global' });
    const newId = addFact({ subject: 'User', predicate: 'prefers editor', object: 'helix', factType: 'preference', scope: 'global' });

    expect(factRow(oldId).status).toBe('superseded');
    expect(factRow(newId).status).toBe('active');

    const audits = exactAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].targetId).toBe(oldId);
    expect(audits[0].detail).toMatchObject({ action: 'superseded', sourceFactId: newId, factType: 'preference' });
  });

  it('state: same subject+predicate archives the old value (type-aware disposition)', () => {
    const oldId = addFact({ subject: 'LoginFlow', predicate: 'currently blocked by', object: 'expired cert', factType: 'state' });
    addFact({ subject: 'LoginFlow', predicate: 'currently blocked by', object: 'missing env', factType: 'state' });

    const old = factRow(oldId);
    expect(old.status).toBe('archived');
    expect(old.decay_bucket).toBe('archived');
    expect(exactAudits()[0].detail.action).toBe('archived');
  });

  it('semantic: same subject+predicate complementary facts coexist', () => {
    const ids = ['DEPLOY_KEY', 'DEPLOY_REGION', 'DEPLOY_BUCKET'].map(name => addFact({
      subject: 'DeployPipeline', predicate: 'requires env var', object: `${name} set`,
    }));

    for (const id of ids) expect(factRow(id).status).toBe('active');
    expect(exactAudits()).toHaveLength(0);
  });

  it('content dedup still wins over the exact path for identical facts', () => {
    addFact({ subject: 'User', predicate: 'prefers editor', object: 'vim', factType: 'preference', scope: 'global' });
    const dupId = addFact({ subject: 'User', predicate: 'prefers editor', object: 'vim', factType: 'preference', scope: 'global' });

    expect(dupId).toBeNull();
    expect(exactAudits()).toHaveLength(0);
  });
});
