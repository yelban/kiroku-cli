import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..', '..');
const MIGRATIONS_DIR = join(ROOT_DIR, 'migrations');
const SCORE_PATH = join(ROOT_DIR, 'test-results', 'memora-score.json');
const PROJECT_ID = 'memora-fama-project';
const NOW_ISO = '2026-03-07T12:00:00.000Z';
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

const dbState = vi.hoisted(() => ({
  db: null,
  vecEnabled: false,
}));

const embedderState = vi.hoisted(() => ({
  vectors: new Map(),
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
      embedding: {
        model: 'test-deterministic-embedding',
        dtype: 'fp32',
      },
    },
  }),
}));

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => loggerMock,
}));

vi.mock('../../src/worker/embedder.js', () => ({
  initEmbedder: vi.fn(async () => {}),
  embedTexts: vi.fn(async texts => texts.map(text => {
    const vector = embedderState.vectors.get(text);
    if (!vector) throw new Error(`No deterministic test embedding registered for: ${text}`);
    return vector;
  })),
}));

const sqliteVecProbe = await probeSqliteVec();
const { selectMemorySearchRows } = await import('../../src/mcp/memory-search.js');
const { selectProjectBriefRows } = await import('../../src/mcp/project-brief.js');
const {
  runDecaySweep,
  setDb,
  storeEmbeddings,
  storeEntities,
  storeFacts,
} = await import('../../src/worker/store.js');

const scoreState = {
  questions: [],
};

// Measured M1-3 mixed-ranking baseline: 0.673797 -> 0.764706.
// M2-2 semantic supersede baseline: 0.764706 -> 0.882353.
// M3-1 update/delete operation baseline: 0.882353 -> 0.941176.
// M3-2 move operation baseline: 0.941176 -> 1.0.
// Update only when a memory-behavior change intentionally changes the mini-FAMA score and the new baseline is reviewed.
const BASELINE_FAMA_FLOOR = 1.0;

function createMemoraDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  sqliteVecProbe.module.load(db);

  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.toUpperCase().startsWith('PRAGMA'));
    for (const statement of statements) db.exec(statement);
  }

  db.prepare('INSERT INTO projects (id, name, last_active_at) VALUES (?, ?, ?)')
    .run(PROJECT_ID, PROJECT_ID, NOW_ISO);
  return db;
}

async function probeSqliteVec() {
  try {
    const sqliteVec = await import('sqlite-vec');
    const db = new Database(':memory:');
    sqliteVec.load(db);
    db.exec('CREATE VIRTUAL TABLE vec_probe USING vec0(id TEXT PRIMARY KEY, embedding float[1024])');
    const vector = new Float32Array(EMBEDDING_DIMS);
    vector[0] = 1;
    db.prepare('INSERT INTO vec_probe(id, embedding) VALUES (?, ?)').run('probe', Buffer.from(vector.buffer));
    const row = db.prepare('SELECT id, distance FROM vec_probe WHERE embedding MATCH ? AND k = 1')
      .get(Buffer.from(vector.buffer));
    db.close();
    return { loaded: row?.id === 'probe' && row.distance === 0, module: sqliteVec, error: null };
  } catch (err) {
    return { loaded: false, module: null, error: err };
  }
}

function vector(components) {
  const arr = Array(EMBEDDING_DIMS).fill(0);
  for (const [index, value] of components) arr[index] = value;
  const norm = Math.sqrt(arr.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return arr;
  return arr.map(value => value / norm);
}

function basis(index) {
  return vector([[index, 1]]);
}

function pairedVector(index, cosine) {
  return vector([[index, cosine], [index + 500, Math.sqrt(1 - cosine * cosine)]]);
}

// Repo embedder measured with Xenova/bge-m3 q8 over `${subject} ${predicate} ${object}` pairs.
// Fixtures stay within ±0.02 of measured cosine while avoiding Float32 threshold edges.
const BGE_M3_FIXTURE_COSINES = {
  q02DecisionReplacement: 0.59, // measured 0.580401
  q03FixedStateBug: 0.81,       // measured 0.801553
  q04RemovedDependency: 0.84,   // measured 0.841521
  q05MovedFile: 0.87,           // measured 0.867245
};

function registerQueryVector(query, embedding) {
  embedderState.vectors.set(query, embedding);
}

function ensureProject(projectId = PROJECT_ID) {
  dbState.db.prepare('INSERT OR IGNORE INTO projects (id, name, last_active_at) VALUES (?, ?, ?)')
    .run(projectId, projectId, NOW_ISO);
}

function addFact({
  subject,
  predicate,
  object,
  detail = null,
  factType = 'semantic',
  confidence = 1,
  operation,
  from,
  to,
  scope,
  projectId = PROJECT_ID,
  embedding,
  createdAt = NOW_ISO,
  lastAccessedAt = createdAt,
  heat = 0.7,
  baseHeat = heat,
  accessCount = 0,
}) {
  ensureProject(projectId);
  const entityNames = [...new Set([subject, endpointName(from), endpointName(to)].filter(Boolean))];
  const entityMap = storeEntities(entityNames.map(name => ({
    canonical_name: name,
    entity_type: name.includes('/') ? 'file' : 'concept',
  })), projectId);
  const fact = {
    subject,
    predicate,
    object,
    detail,
    fact_type: factType,
    confidence,
    operation,
    from,
    to,
    scope,
  };
  const [factId] = storeFacts([fact], entityMap, projectId, null, null);
  if (!factId) throw new Error(`Fact was unexpectedly deduped: ${subject} ${predicate} ${object}`);

  dbState.db.prepare(`
    UPDATE facts
    SET created_at = ?, updated_at = ?, last_accessed_at = ?, heat = ?,
        base_heat = ?, access_count = ?
    WHERE id = ?
  `).run(createdAt, createdAt, lastAccessedAt, heat, baseHeat, accessCount, factId);

  if (embedding) {
    storeEmbeddings([factId], [embedding], projectId, [fact]);
  }

  return factId;
}

function endpointName(endpoint) {
  if (!endpoint) return null;
  if (typeof endpoint === 'string') return endpoint;
  return endpoint.canonical_name || endpoint.name || null;
}

async function searchRows(query, topK = 10) {
  const rows = await selectMemorySearchRows({
    query,
    project_id: PROJECT_ID,
    top_k: topK,
    scope: 'all',
  });
  if (rows.length > 0 && !rows.every(row => typeof row.distance === 'number')) {
    throw new Error('Expected sqlite-vec path; selectMemorySearchRows returned text-search rows.');
  }
  return rows;
}

function hasFact(rows, matcher) {
  return rows.some(row => Object.entries(matcher).every(([key, value]) => row[key] === value));
}

function factIndex(rows, matcher) {
  return rows.findIndex(row => Object.entries(matcher).every(([key, value]) => row[key] === value));
}

async function evaluateQuestion(meta, fn) {
  const criteria = [];
  const criterion = (kind, name, passed, observed = undefined) => {
    criteria.push({ kind, name, passed: Boolean(passed), observed });
  };

  try {
    await fn({ criterion });
  } catch (err) {
    criteria.push({
      kind: 'appear',
      name: 'question executed without infrastructure error',
      passed: false,
      observed: err instanceof Error ? err.message : String(err),
    });
  }

  const passed = criteria.length > 0 && criteria.every(item => item.passed);
  scoreState.questions.push({
    id: meta.id,
    title: meta.title,
    expected: meta.expected,
    passed,
    criteria,
  });

  expect(
    passed,
    `${meta.id} ${meta.title}\n${criteria.map(item => (
      `- [${item.passed ? 'pass' : 'fail'}] ${item.kind}: ${item.name}` +
      (item.observed === undefined ? '' : ` (observed: ${JSON.stringify(item.observed)})`)
    )).join('\n')}`
  ).toBe(true);
}

function computeScore() {
  const criteria = scoreState.questions.flatMap(question => (
    question.criteria.map(criterion => ({ questionId: question.id, ...criterion }))
  ));
  const appearanceCriteria = criteria.filter(criterion => criterion.kind === 'appear');
  const forgettingCriteria = criteria.filter(criterion => criterion.kind === 'forget');
  const passedAppearance = appearanceCriteria.filter(criterion => criterion.passed).length;
  const passedForgetting = forgettingCriteria.filter(criterion => criterion.passed).length;
  const mpa = passedAppearance / appearanceCriteria.length;
  const faa = passedForgetting / forgettingCriteria.length;
  const lambda = forgettingCriteria.length / (appearanceCriteria.length + forgettingCriteria.length);
  const fama = Math.max(0, mpa - lambda * (1 - faa));

  return {
    mpa: roundScore(mpa),
    faa: roundScore(faa),
    fama: roundScore(fama),
    lambda: roundScore(lambda),
    appearance: {
      passed: passedAppearance,
      total: appearanceCriteria.length,
    },
    forgetting: {
      passed: passedForgetting,
      total: forgettingCriteria.length,
    },
    questions: scoreState.questions,
  };
}

function roundScore(value) {
  return Number(value.toFixed(6));
}

function writeScore(score) {
  mkdirSync(dirname(SCORE_PATH), { recursive: true });
  writeFileSync(SCORE_PATH, `${JSON.stringify(score, null, 2)}\n`);
  console.info(`[memora-fama] MPA=${score.mpa} FAA=${score.faa} FAMA=${score.fama}`);
}

describe.skipIf(!sqliteVecProbe.loaded)('memora mini-FAMA baseline with sqlite-vec', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    loggerMock.debug.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.info.mockClear();
    loggerMock.error.mockClear();
    embedderState.vectors = new Map();
    dbState.db = createMemoraDb();
    dbState.vecEnabled = true;
    setDb(dbState.db);
  });

  afterEach(() => {
    dbState.db?.close();
    dbState.db = null;
    dbState.vecEnabled = false;
    vi.useRealTimers();
  });

  afterAll(() => {
    expect(scoreState.questions).toHaveLength(9);
    const score = computeScore();
    writeScore(score);
    expect(score.fama).toBeGreaterThanOrEqual(BASELINE_FAMA_FLOOR);
  });

  test('01 preference reversal excludes the old preference', async () => {
    await evaluateQuestion({
      id: '01',
      title: 'preference reversal',
      expected: 'pass',
    }, async ({ criterion }) => {
      const query = 'preferred package manager';
      const queryVector = basis(1);
      registerQueryVector(query, queryVector);

      addFact({
        subject: 'User',
        predicate: 'prefers package manager',
        object: 'npm',
        factType: 'preference',
        scope: 'global',
        embedding: queryVector,
        createdAt: '2026-03-01T09:00:00.000Z',
      });
      addFact({
        subject: 'User',
        predicate: 'prefers package manager',
        object: 'pnpm',
        factType: 'preference',
        scope: 'global',
        embedding: queryVector,
        createdAt: '2026-03-02T09:00:00.000Z',
      });

      const rows = await searchRows(query, 5);
      criterion('appear', 'new preference appears', hasFact(rows, { object_text: 'pnpm' }), rows.map(row => row.object_text));
      criterion('forget', 'old preference does not reappear', !hasFact(rows, { object_text: 'npm' }), rows.map(row => row.object_text));
    });
  });

  test('02 paraphrased decision replacement excludes the old decision', async () => {
    await evaluateQuestion({
      id: '02',
      title: 'paraphrased decision replacement',
      expected: 'pass',
    }, async ({ criterion }) => {
      const query = 'storage decision';
      const queryVector = basis(2);
      const replacementVector = pairedVector(2, BGE_M3_FIXTURE_COSINES.q02DecisionReplacement);
      registerQueryVector(query, queryVector);

      addFact({
        subject: 'PersistenceLayer',
        predicate: 'selected storage engine',
        object: 'Lowdb',
        embedding: queryVector,
        createdAt: '2026-02-20T10:00:00.000Z',
      });
      addFact({
        subject: 'PersistenceLayer',
        predicate: 'standardizes on database',
        object: 'SQLite',
        embedding: replacementVector,
        createdAt: '2026-03-03T10:00:00.000Z',
      });

      const rows = await searchRows(query, 5);
      criterion('appear', 'replacement decision appears', hasFact(rows, { object_text: 'SQLite' }), rows.map(row => row.object_text));
      criterion('forget', 'obsolete decision does not reappear', !hasFact(rows, { object_text: 'Lowdb' }), rows.map(row => row.object_text));
    });
  });

  test('03 fixed state bug excludes the broken-state fact', async () => {
    await evaluateQuestion({
      id: '03',
      title: 'fixed state bug',
      expected: 'pass',
    }, async ({ criterion }) => {
      const query = 'oauth callback bug status';
      const queryVector = basis(3);
      const fixedVector = pairedVector(3, BGE_M3_FIXTURE_COSINES.q03FixedStateBug);
      registerQueryVector(query, queryVector);

      addFact({
        subject: 'OAuthCallback',
        predicate: 'currently fails with',
        object: '500 on missing state parameter',
        factType: 'state',
        embedding: queryVector,
        createdAt: '2026-02-22T10:00:00.000Z',
      });
      addFact({
        subject: 'OAuthCallback',
        predicate: 'was fixed by',
        object: 'guarding the missing state parameter',
        factType: 'state',
        embedding: fixedVector,
        createdAt: '2026-03-04T10:00:00.000Z',
      });

      const rows = await searchRows(query, 5);
      criterion('appear', 'fixed-state fact appears', hasFact(rows, { object_text: 'guarding the missing state parameter' }), rows.map(row => row.object_text));
      criterion('forget', 'broken-state fact does not reappear', !hasFact(rows, { object_text: '500 on missing state parameter' }), rows.map(row => row.object_text));
    });
  });

  test('04 removed dependency excludes the stale dependency fact', async () => {
    await evaluateQuestion({
      id: '04',
      title: 'removed dependency',
      expected: 'pass',
    }, async ({ criterion }) => {
      const query = 'left-pad dependency';
      const queryVector = basis(4);
      const removalVector = pairedVector(4, BGE_M3_FIXTURE_COSINES.q04RemovedDependency);
      registerQueryVector(query, queryVector);

      addFact({
        subject: 'package.json',
        predicate: 'depends on',
        object: 'left-pad',
        embedding: queryVector,
        createdAt: '2026-02-18T10:00:00.000Z',
      });
      addFact({
        subject: 'package.json',
        predicate: 'removed dependency',
        object: 'left-pad',
        operation: 'delete',
        confidence: 0.9,
        embedding: removalVector,
        createdAt: '2026-03-05T10:00:00.000Z',
      });

      const rows = await searchRows(query, 5);
      criterion('appear', 'removal fact appears', hasFact(rows, { predicate: 'removed dependency', object_text: 'left-pad' }), rows.map(row => `${row.predicate} ${row.object_text}`));
      criterion('forget', 'stale dependency fact does not reappear', !hasFact(rows, { predicate: 'depends on', object_text: 'left-pad' }), rows.map(row => `${row.predicate} ${row.object_text}`));
    });
  });

  test('05 moved file excludes the old path fact', async () => {
    await evaluateQuestion({
      id: '05',
      title: 'moved file',
      expected: 'pass',
    }, async ({ criterion }) => {
      const query = 'cache adapter file path';
      const queryVector = basis(5);
      const newPathVector = pairedVector(5, BGE_M3_FIXTURE_COSINES.q05MovedFile);
      registerQueryVector(query, queryVector);

      addFact({
        subject: 'src/legacy/cache.js',
        predicate: 'contains',
        object: 'cache adapter',
        embedding: queryVector,
        createdAt: '2026-02-16T10:00:00.000Z',
      });
      addFact({
        subject: 'src/cache/adapter.js',
        predicate: 'now contains',
        object: 'cache adapter',
        operation: 'move',
        from: 'src/legacy/cache.js',
        to: 'src/cache/adapter.js',
        confidence: 0.9,
        embedding: newPathVector,
        createdAt: '2026-03-06T10:00:00.000Z',
      });

      const rows = await searchRows(query, 5);
      criterion('appear', 'new path fact appears', hasFact(rows, { subject: 'src/cache/adapter.js', object_text: 'cache adapter' }), rows.map(row => row.subject));
      criterion('forget', 'old path fact does not reappear', !hasFact(rows, { subject: 'src/legacy/cache.js', object_text: 'cache adapter' }), rows.map(row => row.subject));
    });
  });

  test('06 distant recall retrieves an early fact after many unrelated facts', async () => {
    await evaluateQuestion({
      id: '06',
      title: 'distant recall',
      expected: 'pass',
    }, async ({ criterion }) => {
      const query = 'release checklist owner';
      const queryVector = basis(6);
      registerQueryVector(query, queryVector);

      addFact({
        subject: 'ReleaseChecklist',
        predicate: 'owner is',
        object: 'platform team',
        factType: 'task',
        embedding: queryVector,
        createdAt: '2026-01-01T09:00:00.000Z',
      });

      for (let i = 0; i < 80; i++) {
        addFact({
          subject: `NoiseTopic${i}`,
          predicate: 'mentions',
          object: `unrelated implementation note ${i}`,
          embedding: basis(100 + i),
          createdAt: `2026-02-${String((i % 20) + 1).padStart(2, '0')}T09:00:00.000Z`,
        });
      }

      const rows = await searchRows(query, 5);
      criterion('appear', 'early relevant fact appears after unrelated writes', hasFact(rows, { subject: 'ReleaseChecklist', object_text: 'platform team' }), rows.map(row => row.subject));
    });
  });

  test('07 topic completeness returns all complementary facts within top_k', async () => {
    await evaluateQuestion({
      id: '07',
      title: 'topic completeness',
      expected: 'pass',
    }, async ({ criterion }) => {
      const query = 'sync engine design';
      const queryVector = basis(7);
      registerQueryVector(query, queryVector);

      const expectedFacts = [
        ['uses cursor tokens', 'for pagination checkpoints'],
        ['persists checkpoints', 'in the jobs table'],
        ['retries idempotently', 'with request fingerprints'],
      ];

      for (const [predicate, object] of expectedFacts) {
        addFact({
          subject: 'SyncEngine',
          predicate,
          object,
          embedding: queryVector,
        });
      }

      const rows = await searchRows(query, 3);
      for (const [predicate, object] of expectedFacts) {
        criterion('appear', `${predicate} appears`, hasFact(rows, { predicate, object_text: object }), rows.map(row => `${row.predicate} ${row.object_text}`));
      }
    });
  });

  test('08 newer fact ranks ahead despite slightly lower vector similarity', async () => {
    await evaluateQuestion({
      id: '08',
      title: 'newer-vs-older ranking',
      expected: 'pass',
    }, async ({ criterion }) => {
      const query = 'ranking arbitration';
      const queryVector = basis(8);
      const oldVector = basis(8);
      const newVector = vector([[8, 0.97], [9, 0.243105]]);
      registerQueryVector(query, queryVector);

      addFact({
        subject: 'RankingBaseline',
        predicate: 'uses cache policy',
        object: 'legacy exact-match policy',
        embedding: oldVector,
        createdAt: '2026-01-10T10:00:00.000Z',
        lastAccessedAt: '2026-01-10T10:00:00.000Z',
        heat: 0.2,
        baseHeat: 0.2,
      });
      addFact({
        subject: 'RankingDecision',
        predicate: 'uses cache policy',
        object: 'fresh heat-aware policy',
        embedding: newVector,
        createdAt: '2026-03-07T10:00:00.000Z',
        lastAccessedAt: '2026-03-07T10:00:00.000Z',
        heat: 1.0,
        baseHeat: 1.0,
      });

      const rows = await searchRows(query, 2);
      const oldIndex = factIndex(rows, { object_text: 'legacy exact-match policy' });
      const newIndex = factIndex(rows, { object_text: 'fresh heat-aware policy' });
      criterion('appear', 'newer fact ranks before older higher-similarity fact', newIndex !== -1 && oldIndex !== -1 && newIndex < oldIndex, rows.map(row => ({
        object: row.object_text,
        distance: row.distance,
        heat: row.heat,
      })));
    });
  });

  test('09 decayed stale fact sinks out of the project brief', async () => {
    await evaluateQuestion({
      id: '09',
      title: 'decay correctness',
      expected: 'pass',
    }, async ({ criterion }) => {
      const oldFactId = addFact({
        subject: 'DeprecatedState',
        predicate: 'still blocks',
        object: 'old retry rollout',
        factType: 'state',
        embedding: basis(10),
        createdAt: '2026-01-01T10:00:00.000Z',
        lastAccessedAt: '2026-01-01T10:00:00.000Z',
        heat: 1.0,
        baseHeat: 1.0,
      });

      for (let i = 0; i < 4; i++) {
        addFact({
          subject: `CurrentState${i}`,
          predicate: 'tracks',
          object: `active rollout guard ${i}`,
          factType: 'state',
          embedding: basis(20 + i),
          createdAt: '2026-03-07T10:00:00.000Z',
          lastAccessedAt: '2026-03-07T10:00:00.000Z',
          heat: 1.0,
          baseHeat: 1.0,
        });
      }

      await runDecaySweep({
        worker: {
          decay: {
            enabled: true,
            halfLifeHours: 168,
            halfLifeByType: {
              state: 168,
              episodic: 336,
              task: 504,
              semantic: 1440,
              preference: null,
            },
            floorByType: {
              state: 0.05,
              episodic: 0.1,
              task: 0.15,
              semantic: 0.3,
              preference: 0.7,
            },
            freezeAfterInactiveDays: 0,
          },
        },
      });

      const oldFact = dbState.db.prepare('SELECT heat, decay_bucket FROM facts WHERE id = ?').get(oldFactId);
      const briefRows = selectProjectBriefRows(dbState.db, PROJECT_ID, { maxFacts: 3 });

      criterion('appear', 'current hot state facts remain eligible for brief', briefRows.length === 3 && briefRows.every(row => row.subject.startsWith('CurrentState')), briefRows.map(row => row.subject));
      criterion('forget', 'decayed stale state fact reaches cold floor and is not selected into brief', oldFact.heat <= 0.051 && oldFact.decay_bucket === 'cold' && !hasFact(briefRows, { subject: 'DeprecatedState' }), {
        briefSubjects: briefRows.map(row => row.subject),
        oldFact,
      });
    });
  });
});

describe.skipIf(sqliteVecProbe.loaded)('memora mini-FAMA sqlite-vec fallback notice', () => {
  test('sqlite-vec load failure leaves only text-path tests runnable', () => {
    expect(sqliteVecProbe.loaded, sqliteVecProbe.error?.message).toBe(false);
  });
});
