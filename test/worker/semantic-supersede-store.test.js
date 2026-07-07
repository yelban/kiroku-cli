import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const PROJECT_ID = 'semantic-supersede-project';
const EMBEDDING_DIMS = 1024;
const MIGRATION_FILES = [
  '001_init.sql',
  '002_vec.sql',
  '003_scope.sql',
  '004_scope_vec.sql',
  '005_heat_decay.sql',
  '006_audit_log.sql',
  '007_v12_enhancements.sql',
  '008_content_dedup_index.sql',
];
const VEC_MIGRATION_FILES = new Set(['002_vec.sql', '004_scope_vec.sql']);

const dbState = vi.hoisted(() => ({
  db: null,
  vecEnabled: false,
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/shared/db.js', () => ({
  getDb: () => dbState.db,
  isVecEnabled: () => dbState.vecEnabled,
}));

vi.mock('../../src/shared/config.js', () => ({
  loadConfig: () => ({
    worker: {
      supersede: {
        enabled: true,
        semanticThreshold: 0.58,
        stateTaskThreshold: 0.8,
      },
    },
  }),
}));

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => loggerMock,
}));

const sqliteVecProbe = await probeSqliteVec();
const {
  setDb,
  storeEmbeddings,
  storeEntities,
  storeFacts,
} = await import('../../src/worker/store.js');

async function probeSqliteVec() {
  try {
    const sqliteVec = await import('sqlite-vec');
    const db = new Database(':memory:');
    sqliteVec.load(db);
    db.exec('CREATE VIRTUAL TABLE vec_probe USING vec0(id TEXT PRIMARY KEY, embedding float[1024])');
    const vector = basis(0);
    db.prepare('INSERT INTO vec_probe(id, embedding) VALUES (?, ?)').run('probe', Buffer.from(vector.buffer));
    const row = db.prepare('SELECT id, distance FROM vec_probe WHERE embedding MATCH ? AND k = 1')
      .get(Buffer.from(vector.buffer));
    db.close();
    return { loaded: row?.id === 'probe' && row.distance === 0, module: sqliteVec, error: null };
  } catch (err) {
    return { loaded: false, module: null, error: err };
  }
}

function createTestDb({ withVec = true } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  if (withVec) sqliteVecProbe.module.load(db);

  for (const file of MIGRATION_FILES) {
    if (!withVec && VEC_MIGRATION_FILES.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.toUpperCase().startsWith('PRAGMA'));
    for (const statement of statements) db.exec(statement);
  }

  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(PROJECT_ID, PROJECT_ID);
  return db;
}

function addFact({
  subject,
  predicate,
  object,
  factType = 'semantic',
  confidence = 1,
  operation,
  from,
  to,
  embedding,
}) {
  const entityNames = [...new Set([subject, endpointName(from), endpointName(to)].filter(Boolean))];
  const entityMap = storeEntities(entityNames.map(name => ({
    canonical_name: name,
    entity_type: name.includes('/') ? 'file' : 'concept',
  })), PROJECT_ID);
  const fact = { subject, predicate, object, fact_type: factType, confidence, operation, from, to };
  const [factId] = storeFacts([fact], entityMap, PROJECT_ID, null, { licensed: true });
  expect(factId).toBeTruthy();
  if (embedding) storeEmbeddings([factId], [embedding], PROJECT_ID, [fact]);
  return factId;
}

function endpointName(endpoint) {
  if (!endpoint) return null;
  if (typeof endpoint === 'string') return endpoint;
  return endpoint.canonical_name || endpoint.name || null;
}

function basis(index) {
  const arr = new Float32Array(EMBEDDING_DIMS);
  arr[index] = 1;
  return arr;
}

function vectorWithCosine(cosine) {
  const arr = new Float32Array(EMBEDDING_DIMS);
  arr[0] = cosine;
  arr[1] = Math.sqrt(1 - cosine * cosine);
  return arr;
}

describe.skipIf(!sqliteVecProbe.loaded)('semantic supersede store pass', () => {
  beforeEach(() => {
    loggerMock.debug.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.info.mockClear();
    loggerMock.error.mockClear();
    dbState.db = createTestDb();
    dbState.vecEnabled = true;
    setDb(dbState.db);
  });

  it('supersedes an obsolete semantic fact, syncs embedding status, and writes audit', () => {
    const oldId = addFact({
      subject: 'PersistenceLayer',
      predicate: 'selected storage engine',
      object: 'Lowdb',
      embedding: basis(0),
    });
    const newId = addFact({
      subject: 'PersistenceLayer',
      predicate: 'standardizes on database',
      object: 'SQLite',
      embedding: vectorWithCosine(0.59),
    });

    expect(dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(oldId).status).toBe('superseded');
    expect(dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(newId).status).toBe('active');
    expect(dbState.db.prepare('SELECT status FROM fact_embeddings WHERE fact_id = ?').get(oldId).status).toBe('superseded');

    const audit = dbState.db.prepare(`
      SELECT action, target_id, detail_json
      FROM audit_logs
      WHERE action = 'semantic_supersede'
    `).get();
    expect(audit).toMatchObject({ action: 'semantic_supersede', target_id: oldId });
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      sourceFactId: newId,
      targetFactId: oldId,
      action: 'supersede',
      threshold: 0.58,
    });
  });

  it('archives state facts and marks their embeddings archived', () => {
    const oldId = addFact({
      subject: 'OAuthCallback',
      predicate: 'currently fails with',
      object: '500 on missing state parameter',
      factType: 'state',
      embedding: basis(0),
    });
    addFact({
      subject: 'OAuthCallback',
      predicate: 'was fixed by',
      object: 'guarding the missing state parameter',
      factType: 'state',
      embedding: vectorWithCosine(0.8),
    });

    expect(dbState.db.prepare('SELECT status, decay_bucket FROM facts WHERE id = ?').get(oldId))
      .toMatchObject({ status: 'archived', decay_bucket: 'archived' });
    expect(dbState.db.prepare('SELECT status FROM fact_embeddings WHERE fact_id = ?').get(oldId).status).toBe('archived');
  });

  it('delete operation archives same-object semantic targets and audits operation details', () => {
    const oldId = addFact({
      subject: 'package.json',
      predicate: 'depends on',
      object: 'left-pad',
      embedding: basis(0),
    });
    const newId = addFact({
      subject: 'package.json',
      predicate: 'removed dependency',
      object: 'left-pad',
      operation: 'delete',
      confidence: 0.8,
      embedding: vectorWithCosine(0.84),
    });

    expect(dbState.db.prepare('SELECT status, decay_bucket FROM facts WHERE id = ?').get(oldId))
      .toMatchObject({ status: 'archived', decay_bucket: 'archived' });
    expect(dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(newId).status).toBe('active');
    expect(dbState.db.prepare('SELECT status FROM fact_embeddings WHERE fact_id = ?').get(oldId).status).toBe('archived');

    const audit = dbState.db.prepare(`
      SELECT action, target_id, detail_json
      FROM audit_logs
      WHERE action = 'memory_operation'
    `).get();
    expect(audit).toMatchObject({ action: 'memory_operation', target_id: oldId });
    const detail = JSON.parse(audit.detail_json);
    expect(detail).toMatchObject({
      operation: 'delete',
      result: 'applied',
      action: 'archive',
      confidence: 0.8,
      sourceFactId: newId,
      targetFactId: oldId,
      threshold: 0.58,
    });
    expect(detail.cosine).toBeCloseTo(0.84);
  });

  it('skips low-confidence operation disposal while storing the new fact and audit', () => {
    const oldId = addFact({
      subject: 'package.json',
      predicate: 'depends on',
      object: 'left-pad',
      embedding: basis(0),
    });
    const newId = addFact({
      subject: 'package.json',
      predicate: 'removed dependency',
      object: 'left-pad',
      operation: 'delete',
      confidence: 0.799,
      embedding: vectorWithCosine(0.84),
    });

    expect(dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(oldId).status).toBe('active');
    expect(dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(newId).status).toBe('active');
    expect(dbState.db.prepare('SELECT status FROM fact_embeddings WHERE fact_id = ?').get(oldId).status).toBe('active');

    const audit = dbState.db.prepare(`
      SELECT action, target_id, detail_json
      FROM audit_logs
      WHERE action = 'memory_operation'
    `).get();
    expect(audit).toMatchObject({ action: 'memory_operation', target_id: oldId });
    const detail = JSON.parse(audit.detail_json);
    expect(detail).toMatchObject({
      operation: 'delete',
      result: 'skipped',
      reason: 'operation_confidence_below_threshold',
      confidence: 0.799,
      sourceFactId: newId,
      targetFactId: oldId,
    });
    expect(detail.cosine).toBeCloseTo(0.84);
  });

  it('move operation supersedes from-entity facts, syncs embeddings, merges aliases, and audits', () => {
    const oldId = addFact({
      subject: 'src/legacy/cache.js',
      predicate: 'contains',
      object: 'cache adapter',
      embedding: basis(0),
    });
    const moveId = addFact({
      subject: 'src/cache/adapter.js',
      predicate: 'now contains',
      object: 'cache adapter',
      operation: 'move',
      from: 'src/legacy/cache.js',
      to: 'src/cache/adapter.js',
      confidence: 0.8,
      embedding: vectorWithCosine(0.87),
    });

    expect(dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(oldId).status).toBe('superseded');
    expect(dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(moveId).status).toBe('active');
    expect(dbState.db.prepare('SELECT status FROM fact_embeddings WHERE fact_id = ?').get(oldId).status).toBe('superseded');

    const targetEntity = dbState.db.prepare('SELECT id, aliases_json FROM entities WHERE canonical_name = ?')
      .get('src/cache/adapter.js');
    expect(JSON.parse(targetEntity.aliases_json)).toContain('src/legacy/cache.js');

    const audit = dbState.db.prepare(`
      SELECT action, target_type, target_id, detail_json
      FROM audit_logs
      WHERE action = 'memory_operation'
    `).get();
    expect(audit).toMatchObject({
      action: 'memory_operation',
      target_type: 'entity',
      target_id: targetEntity.id,
    });
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      operation: 'move',
      result: 'applied',
      action: 'move',
      confidence: 0.8,
      sourceFactId: moveId,
      targetFactIds: [oldId],
      fromEntityId: expect.any(String),
      toEntityId: targetEntity.id,
      addedAliases: ['src/legacy/cache.js'],
    });
  });

  it('skips low-confidence move side effects while storing and auditing the move fact', () => {
    const oldId = addFact({
      subject: 'src/legacy/cache.js',
      predicate: 'contains',
      object: 'cache adapter',
      embedding: basis(0),
    });
    const moveId = addFact({
      subject: 'src/cache/adapter.js',
      predicate: 'now contains',
      object: 'cache adapter',
      operation: 'move',
      from: 'src/legacy/cache.js',
      to: 'src/cache/adapter.js',
      confidence: 0.799,
      embedding: vectorWithCosine(0.87),
    });

    expect(dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(oldId).status).toBe('active');
    expect(dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(moveId).status).toBe('active');
    expect(dbState.db.prepare('SELECT status FROM fact_embeddings WHERE fact_id = ?').get(oldId).status).toBe('active');

    const targetEntity = dbState.db.prepare('SELECT id, aliases_json FROM entities WHERE canonical_name = ?')
      .get('src/cache/adapter.js');
    expect(JSON.parse(targetEntity.aliases_json)).not.toContain('src/legacy/cache.js');

    const audit = dbState.db.prepare(`
      SELECT action, target_type, target_id, detail_json
      FROM audit_logs
      WHERE action = 'memory_operation'
    `).get();
    expect(audit).toMatchObject({
      action: 'memory_operation',
      target_type: 'entity',
      target_id: targetEntity.id,
    });
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      operation: 'move',
      result: 'skipped',
      reason: 'operation_confidence_below_threshold',
      confidence: 0.799,
      sourceFactId: moveId,
      targetFactIds: [],
      toEntityId: targetEntity.id,
    });
  });

  it('keeps complementary same-subject semantic facts active', () => {
    const firstId = addFact({
      subject: 'SyncEngine',
      predicate: 'uses cursor tokens',
      object: 'for pagination checkpoints',
      embedding: basis(0),
    });
    const secondId = addFact({
      subject: 'SyncEngine',
      predicate: 'persists checkpoints',
      object: 'in the jobs table',
      embedding: basis(0),
    });

    const rows = dbState.db.prepare('SELECT id, status FROM facts WHERE id IN (?, ?) ORDER BY id')
      .all(firstId, secondId);
    expect(rows.every(row => row.status === 'active')).toBe(true);
    expect(dbState.db.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE action = ?').get('semantic_supersede').count)
      .toBe(0);
  });
});

describe('operation fallback without embeddings', () => {
  beforeEach(() => {
    loggerMock.debug.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.info.mockClear();
    loggerMock.error.mockClear();
    dbState.db = createTestDb({ withVec: false });
    dbState.vecEnabled = false;
    setDb(dbState.db);
  });

  it('archives exact same-subject object matches when vector embeddings are unavailable', () => {
    const oldId = addFact({
      subject: 'package.json',
      predicate: 'depends on',
      object: 'left-pad',
    });
    const newId = addFact({
      subject: 'package.json',
      predicate: 'removed dependency',
      object: 'left-pad',
      operation: 'delete',
      confidence: 0.9,
    });

    expect(dbState.db.prepare('SELECT status, decay_bucket FROM facts WHERE id = ?').get(oldId))
      .toMatchObject({ status: 'archived', decay_bucket: 'archived' });
    expect(dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(newId).status).toBe('active');

    const audit = dbState.db.prepare(`
      SELECT action, target_id, detail_json
      FROM audit_logs
      WHERE action = 'memory_operation'
    `).get();
    expect(audit).toMatchObject({ action: 'memory_operation', target_id: oldId });
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      operation: 'delete',
      result: 'applied',
      action: 'archive',
      confidence: 0.9,
      sourceFactId: newId,
      targetFactId: oldId,
      cosine: null,
    });
  });

  it('applies move operation without vector embeddings', () => {
    const oldId = addFact({
      subject: 'src/legacy/cache.js',
      predicate: 'contains',
      object: 'cache adapter',
    });
    const moveId = addFact({
      subject: 'src/cache/adapter.js',
      predicate: 'now contains',
      object: 'cache adapter',
      operation: 'move',
      from: 'src/legacy/cache.js',
      to: 'src/cache/adapter.js',
      confidence: 0.9,
    });

    expect(dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(oldId).status).toBe('superseded');
    expect(dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(moveId).status).toBe('active');

    const targetEntity = dbState.db.prepare('SELECT id, aliases_json FROM entities WHERE canonical_name = ?')
      .get('src/cache/adapter.js');
    expect(JSON.parse(targetEntity.aliases_json)).toContain('src/legacy/cache.js');

    const audit = dbState.db.prepare(`
      SELECT action, target_type, target_id, detail_json
      FROM audit_logs
      WHERE action = 'memory_operation'
    `).get();
    expect(audit).toMatchObject({
      action: 'memory_operation',
      target_type: 'entity',
      target_id: targetEntity.id,
    });
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      operation: 'move',
      result: 'applied',
      action: 'move',
      confidence: 0.9,
      sourceFactId: moveId,
      targetFactIds: [oldId],
      toEntityId: targetEntity.id,
    });
  });
});
