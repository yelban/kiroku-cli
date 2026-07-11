import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const EMBEDDING_DIMS = 1024;
const PROJECT_ID = 'compaction-conflict-project';
const MIGRATION_FILES = [
  '001_init.sql',
  '003_scope.sql',
  '005_heat_decay.sql',
  '006_audit_log.sql',
  '007_v12_enhancements.sql',
  '008_content_dedup_index.sql',
];

const dbState = vi.hoisted(() => ({
  vecEnabled: true,
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/shared/db.js', () => ({
  isVecEnabled: () => dbState.vecEnabled,
}));

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => loggerMock,
}));

const { runCompactionSweep } = await import('../../src/worker/store.js');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.toUpperCase().startsWith('PRAGMA'));
    for (const statement of statements) db.exec(statement);
  }

  db.exec(`
    CREATE TABLE fact_embeddings (
      fact_id TEXT PRIMARY KEY,
      project_id TEXT,
      scope TEXT,
      fact_type TEXT,
      status TEXT,
      embedding BLOB
    )
  `);
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(PROJECT_ID, PROJECT_ID);
  return db;
}

function seedEntity(db, name) {
  const id = `ent_${name}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO entities
      (id, canonical_name, entity_type, normalized_name, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, 'concept', name.toLowerCase(), now, now);
  return id;
}

function seedFact(db, {
  subject = 'Compactor',
  predicate = 'uses engine',
  object,
  factType = 'semantic',
  heat,
  baseHeat = heat,
  embedding,
}) {
  const subjectEntityId = seedEntity(db, subject);
  const id = `fact_${object.replace(/\W+/g, '_').toLowerCase()}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO facts
      (id, project_id, subject_entity_id, predicate, object_text, fact_type, confidence, heat,
       decay_bucket, scope, status, base_heat, last_accessed_at, access_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    PROJECT_ID,
    subjectEntityId,
    predicate,
    object,
    factType,
    1,
    heat,
    'hot',
    'project',
    'active',
    baseHeat,
    now,
    0,
  );

  db.prepare(`
    INSERT INTO fact_embeddings (fact_id, project_id, scope, fact_type, status, embedding)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, PROJECT_ID, 'project', factType, 'active', Buffer.from(embedding.buffer));

  return id;
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

function readFact(db, id) {
  return db.prepare('SELECT id, status, heat, base_heat FROM facts WHERE id = ?').get(id);
}

function readConflictAudits(db) {
  return db.prepare(`
    SELECT action, target_type, target_id, detail_json
    FROM audit_logs
    WHERE action = 'conflict_demote'
    ORDER BY target_id
  `).all();
}

describe('runCompactionSweep conflict demotion', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    dbState.vecEnabled = true;
    loggerMock.debug.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.info.mockClear();
    loggerMock.error.mockClear();
  });

  it('demotes both conflicting facts by half and writes one audit per fact', async () => {
    const firstId = seedFact(db, {
      object: 'SQLite',
      factType: 'state',
      heat: 0.8,
      baseHeat: 0.6,
      embedding: basis(0),
    });
    const secondId = seedFact(db, {
      object: 'Postgres',
      factType: 'state',
      heat: 0.7,
      baseHeat: 0.5,
      embedding: vectorWithCosine(0.8),
    });

    await expect(runCompactionSweep(db, {}, {
      floorByType: { state: 0.3 },
    })).resolves.toEqual({ merged: 0, conflicts: 1 });

    expect(readFact(db, firstId)).toMatchObject({ status: 'active', heat: 0.4, base_heat: 0.3 });
    expect(readFact(db, secondId)).toMatchObject({ status: 'active', heat: 0.35, base_heat: 0.3 });

    const audits = readConflictAudits(db);
    expect(audits).toHaveLength(2);
    expect(audits.map(audit => audit.target_id).sort()).toEqual([firstId, secondId].sort());
    expect(audits.every(audit => audit.action === 'conflict_demote' && audit.target_type === 'fact')).toBe(true);

    const detailByTarget = Object.fromEntries(audits.map(audit => [
      audit.target_id,
      JSON.parse(audit.detail_json),
    ]));
    expect(detailByTarget[firstId]).toMatchObject({
      cosine: 0.8,
      conflictingFactId: secondId,
      heatBefore: 0.8,
      heatAfter: 0.4,
      baseHeatBefore: 0.6,
      baseHeatAfter: 0.3,
    });
    expect(detailByTarget[secondId]).toMatchObject({
      cosine: 0.8,
      conflictingFactId: firstId,
      heatBefore: 0.7,
      heatAfter: 0.35,
      baseHeatBefore: 0.5,
      baseHeatAfter: 0.3,
    });
  });

  it('continues demoting repeated conflict sweeps until the type floor', async () => {
    const firstId = seedFact(db, {
      object: 'Redis',
      factType: 'task',
      heat: 0.5,
      baseHeat: 0.5,
      embedding: basis(0),
    });
    const secondId = seedFact(db, {
      object: 'Memcached',
      factType: 'task',
      heat: 0.2,
      baseHeat: 0.2,
      embedding: vectorWithCosine(0.8),
    });
    const decayConfig = { floorByType: { task: 0.15 } };

    await expect(runCompactionSweep(db, {}, decayConfig)).resolves.toEqual({ merged: 0, conflicts: 1 });
    expect(readFact(db, firstId)).toMatchObject({ heat: 0.25, base_heat: 0.25 });
    expect(readFact(db, secondId)).toMatchObject({ heat: 0.15, base_heat: 0.15 });

    await expect(runCompactionSweep(db, {}, decayConfig)).resolves.toEqual({ merged: 0, conflicts: 1 });
    expect(readFact(db, firstId)).toMatchObject({ heat: 0.15, base_heat: 0.15 });
    expect(readFact(db, secondId)).toMatchObject({ heat: 0.15, base_heat: 0.15 });
    expect(readConflictAudits(db)).toHaveLength(4);
  });

  it('uses a zero floor when no decay config is passed', async () => {
    const firstId = seedFact(db, {
      object: 'LevelDB',
      factType: 'state',
      heat: 0.1,
      baseHeat: 0.08,
      embedding: basis(0),
    });
    const secondId = seedFact(db, {
      object: 'RocksDB',
      factType: 'state',
      heat: 0.09,
      baseHeat: 0.06,
      embedding: vectorWithCosine(0.8),
    });

    await expect(runCompactionSweep(db)).resolves.toEqual({ merged: 0, conflicts: 1 });

    expect(readFact(db, firstId)).toMatchObject({ heat: 0.05, base_heat: 0.04 });
    expect(readFact(db, secondId)).toMatchObject({ heat: 0.045, base_heat: 0.03 });
  });

  it('leaves semantic multi-valued same-predicate facts undemoted (G13)', async () => {
    const firstId = seedFact(db, {
      object: 'DEPLOY_KEY set',
      heat: 0.7,
      baseHeat: 0.7,
      embedding: basis(0),
    });
    const secondId = seedFact(db, {
      object: 'DEPLOY_REGION set',
      heat: 0.7,
      baseHeat: 0.7,
      embedding: vectorWithCosine(0.8),
    });

    await expect(runCompactionSweep(db, {}, {
      floorByType: { semantic: 0.3 },
    })).resolves.toEqual({ merged: 0, conflicts: 0 });

    expect(readFact(db, firstId)).toMatchObject({ status: 'active', heat: 0.7 });
    expect(readFact(db, secondId)).toMatchObject({ status: 'active', heat: 0.7 });
    expect(readConflictAudits(db)).toHaveLength(0);
  });

  it('does not merge a same-predicate multi-valued pair even above the merge band (G14)', async () => {
    const firstId = seedFact(db, {
      object: 'CACHE_HOST set',
      heat: 0.8,
      baseHeat: 0.8,
      embedding: basis(0),
    });
    const secondId = seedFact(db, {
      object: 'CACHE_PORT set',
      heat: 0.7,
      baseHeat: 0.7,
      embedding: vectorWithCosine(0.95),
    });

    await expect(runCompactionSweep(db, {}, {
      floorByType: { semantic: 0.3 },
    })).resolves.toEqual({ merged: 0, conflicts: 0 });

    expect(readFact(db, firstId)).toMatchObject({ status: 'active', heat: 0.8 });
    expect(readFact(db, secondId)).toMatchObject({ status: 'active', heat: 0.7 });
  });

  it('demotes a single-valued same-predicate pair above the merge band instead of merging it', async () => {
    const firstId = seedFact(db, {
      object: 'staging',
      factType: 'state',
      heat: 0.8,
      baseHeat: 0.8,
      embedding: basis(0),
    });
    const secondId = seedFact(db, {
      object: 'production',
      factType: 'state',
      heat: 0.6,
      baseHeat: 0.6,
      embedding: vectorWithCosine(0.95),
    });

    await expect(runCompactionSweep(db, {}, {
      floorByType: { state: 0.05 },
    })).resolves.toEqual({ merged: 0, conflicts: 1 });

    expect(readFact(db, firstId)).toMatchObject({ status: 'active', heat: 0.4 });
    expect(readFact(db, secondId)).toMatchObject({ status: 'active', heat: 0.3 });
  });

  it('keeps the high-cosine merge path unchanged', async () => {
    const survivorId = seedFact(db, {
      object: 'DuckDB',
      heat: 0.8,
      baseHeat: 0.8,
      embedding: basis(0),
    });
    const compactedId = seedFact(db, {
      object: 'Duck DB',
      heat: 0.7,
      baseHeat: 0.7,
      embedding: vectorWithCosine(0.95),
    });

    await expect(runCompactionSweep(db, {}, {
      floorByType: { semantic: 0.3 },
    })).resolves.toEqual({ merged: 1, conflicts: 0 });

    expect(readFact(db, survivorId)).toMatchObject({ status: 'active', heat: 0.8, base_heat: 0.8 });
    expect(readFact(db, compactedId)).toMatchObject({ status: 'compacted' });
    expect(db.prepare('SELECT status FROM fact_embeddings WHERE fact_id = ?').get(compactedId).status)
      .toBe('compacted');
    expect(readConflictAudits(db)).toHaveLength(0);
  });
});
