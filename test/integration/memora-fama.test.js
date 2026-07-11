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
  '009_repo_grounding.sql',
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
const { sqlReadonly } = await import('../../src/mcp/sql-sandbox.js');
const { runRepoGroundingSweep } = await import('../../src/worker/repo-grounding.js');
const {
  runCompactionSweep,
  runDecaySweep,
  setDb,
  storeEmbeddings,
  storeEntities,
  storeFacts,
} = await import('../../src/worker/store.js');

const scoreState = {
  questions: [],
};

const behaviorState = {
  searchCalls: 0,
  emptySearchCalls: 0,
  writeAttempts: 0,
  dedupHits: 0,
  supersedeReasons: {},
  briefCalls: 0,
  briefRowCount: 0,
  briefChars: 0,
};

// v1 booklet (questions 01-09), saturated at 1.0 since M3-2. Held as a
// regression asset: any drop means an M1-M3 memory behavior regressed.
// Measured M1-3 mixed-ranking baseline: 0.673797 -> 0.764706.
// M2-2 semantic supersede baseline: 0.764706 -> 0.882353.
// M3-1 update/delete operation baseline: 0.882353 -> 0.941176.
// M3-2 move operation baseline: 0.941176 -> 1.0.
// Update only when a memory-behavior change intentionally changes the mini-FAMA score and the new baseline is reviewed.
const V1_BASELINE_FAMA_FLOOR = 1.0;

// M4 booklet (questions 10-20). Red questions (test.fails) price in the open
// gaps they anchor: 13/14 -> A1 repo grounding, 16/17 -> G9 memory_about,
// 18 -> G13 multi-valued predicate false supersede (exact (subject, predicate)
// supersede in storeFacts assumes single-valued predicates; the semantic
// resolver's same-predicate replacement signal shares the assumption).
// Measured M4-1 baseline (G9/A1/G13 unimplemented): MPA 0.818182, FAA 0.545455, FAMA 0.666667.
// M4-2 memory_about (G9) baseline: FAMA 0.666667 -> 0.774155 (MPA 0.913043, FAA 0.615385).
// A1-2 repo grounding baseline: FAMA 0.774155 -> 0.92 (MPA 0.92, FAA 1.0); question 18 (G13) is the last red.
// G13 single-valued gate baseline: FAMA 0.92 -> 1.0 — the M4 booklet is now
// SATURATED (all 20 questions green, zero test.fails). Do not read 1.0 as
// memory quality being complete; the next improvement round must open by
// expanding the exam again.
const M4_BASELINE_FAMA_FLOOR = 1.0;

// Behavior-metric baselines (AutoMem Figure 4 analogues). Deterministic under
// the fixture workload; both change whenever the question set changes — update
// consciously alongside the floors above.
const EMPTY_SEARCH_RATE_BASELINE = 0.066667; // 1 cold-start empty search / 15 searches
const DEDUP_RATE_BASELINE = 0.003731;        // 1 deliberate repeat-write / 268 write attempts

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

// Repo defaults from config.js worker.decay, with freezing disabled: freeze
// detection reads SQLite's real clock, so per-question sweeps pin it off and
// question 11 opts back in with deterministic extreme last_active_at dates.
const QUARTERLY_DECAY_CONFIG = {
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
};

const GROUNDING_CONFIG = {
  worker: {
    repoGrounding: { enabled: true, confirmHours: 6 },
    decay: QUARTERLY_DECAY_CONFIG.worker.decay,
  },
};

// The grounding sweep only visits projects with a recorded root; snapshots are
// injected synthetically, so the path never touches a real filesystem.
function setProjectRoot(projectId = PROJECT_ID, rootPath = '/synthetic/repo') {
  dbState.db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(rootPath, projectId);
}

async function runGroundingSweep(snapshot, now = NOW_ISO) {
  await runRepoGroundingSweep(dbState.db, GROUNDING_CONFIG, {
    now,
    collectSnapshot: () => ({ ok: true, headCommit: 'synthetic-head', refReset: false, ...snapshot }),
  });
}

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
  allowDedup = false,
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
  behaviorState.writeAttempts += 1;
  const [factId] = storeFacts([fact], entityMap, projectId, null, null);
  if (!factId) {
    behaviorState.dedupHits += 1;
    if (allowDedup) return null;
    throw new Error(`Fact was unexpectedly deduped: ${subject} ${predicate} ${object}`);
  }

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

async function searchRows(query, topK = 10, projectId = PROJECT_ID) {
  const rows = await selectMemorySearchRows({
    query,
    project_id: projectId,
    top_k: topK,
    scope: 'all',
  });
  behaviorState.searchCalls += 1;
  if (rows.length === 0) behaviorState.emptySearchCalls += 1;
  if (rows.length > 0 && !rows.every(row => typeof row.distance === 'number')) {
    throw new Error('Expected sqlite-vec path; selectMemorySearchRows returned text-search rows.');
  }
  return rows;
}

function briefRows(config, projectId = PROJECT_ID) {
  const rows = selectProjectBriefRows(dbState.db, projectId, config);
  behaviorState.briefCalls += 1;
  behaviorState.briefRowCount += rows.length;
  behaviorState.briefChars += rows.reduce(
    (sum, r) => sum + `[${r.fact_type}] ${r.subject || '?'} ${r.predicate} ${r.object_text}`.length,
    0,
  );
  return rows;
}

async function loadMemoryAbout() {
  try {
    const mod = await import('../../src/mcp/memory-about.js');
    return typeof mod.selectMemoryAboutRows === 'function' ? mod : null;
  } catch {
    return null;
  }
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
    booklet: meta.booklet ?? 'v1',
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

function computeScore(questions) {
  const criteria = questions.flatMap(question => (
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
    questions,
  };
}

function computeBehavior() {
  return {
    searchCalls: behaviorState.searchCalls,
    emptySearchCalls: behaviorState.emptySearchCalls,
    emptySearchRate: roundScore(behaviorState.emptySearchCalls / Math.max(1, behaviorState.searchCalls)),
    writeAttempts: behaviorState.writeAttempts,
    dedupHits: behaviorState.dedupHits,
    dedupRate: roundScore(behaviorState.dedupHits / Math.max(1, behaviorState.writeAttempts)),
    supersedeReasons: behaviorState.supersedeReasons,
    brief: {
      calls: behaviorState.briefCalls,
      rows: behaviorState.briefRowCount,
      chars: behaviorState.briefChars,
    },
  };
}

function roundScore(value) {
  return Number(value.toFixed(6));
}

function writeScore(score) {
  mkdirSync(dirname(SCORE_PATH), { recursive: true });
  writeFileSync(SCORE_PATH, `${JSON.stringify(score, null, 2)}\n`);
  const fmt = s => `MPA=${s.mpa} FAA=${s.faa} FAMA=${s.fama}`;
  console.info(`[memora-fama] v1: ${fmt(score.booklets.v1)} | m4: ${fmt(score.booklets.m4)} | overall: ${fmt(score.overall)}`);
  console.info(`[memora-fama] behavior: emptySearchRate=${score.behavior.emptySearchRate} dedupRate=${score.behavior.dedupRate} supersede=${JSON.stringify(score.behavior.supersedeReasons)}`);
}

describe.skipIf(!sqliteVecProbe.loaded)('memora mini-FAMA baseline with sqlite-vec', () => {
  beforeEach(() => {
    // Fake only Date: runCompactionSweep yields via setImmediate, which a
    // full fake-timer install would capture and never resolve.
    vi.useFakeTimers({ toFake: ['Date'] });
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
    if (dbState.db) {
      try {
        const rows = dbState.db.prepare(
          `SELECT action, detail_json FROM audit_logs WHERE action IN ('memory_operation', 'semantic_supersede')`
        ).all();
        for (const row of rows) {
          let detail = {};
          try { detail = JSON.parse(row.detail_json || '{}'); } catch { /* unreadable detail */ }
          const key = row.action === 'memory_operation'
            ? `${detail.operation || 'unknown'}:${detail.result || 'unknown'}${detail.reason ? `:${detail.reason}` : ''}`
            : 'semantic_supersede:applied';
          behaviorState.supersedeReasons[key] = (behaviorState.supersedeReasons[key] || 0) + 1;
        }
      } catch { /* behavior harvest is best-effort */ }
    }
    dbState.db?.close();
    dbState.db = null;
    dbState.vecEnabled = false;
    vi.useRealTimers();
  });

  afterAll(() => {
    const v1Questions = scoreState.questions.filter(question => question.booklet === 'v1');
    const m4Questions = scoreState.questions.filter(question => question.booklet === 'm4');
    expect(v1Questions).toHaveLength(9);
    expect(m4Questions).toHaveLength(11);

    const score = {
      booklets: {
        v1: computeScore(v1Questions),
        m4: computeScore(m4Questions),
      },
      overall: computeScore(scoreState.questions),
      behavior: computeBehavior(),
    };
    writeScore(score);

    expect(score.booklets.v1.fama).toBeGreaterThanOrEqual(V1_BASELINE_FAMA_FLOOR);
    expect(score.booklets.m4.fama).toBeGreaterThanOrEqual(M4_BASELINE_FAMA_FLOOR);
    expect(score.behavior.emptySearchRate).toBe(EMPTY_SEARCH_RATE_BASELINE);
    expect(score.behavior.dedupRate).toBe(DEDUP_RATE_BASELINE);
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
      const brief = briefRows({ maxFacts: 3 });

      criterion('appear', 'current hot state facts remain eligible for brief', brief.length === 3 && brief.every(row => row.subject.startsWith('CurrentState')), brief.map(row => row.subject));
      criterion('forget', 'decayed stale state fact reaches cold floor and is not selected into brief', oldFact.heat <= 0.051 && oldFact.decay_bucket === 'cold' && !hasFact(brief, { subject: 'DeprecatedState' }), {
        briefSubjects: brief.map(row => row.subject),
        oldFact,
      });
    });
  });

  // ── M4 booklet ──────────────────────────────────────────────────────────
  // Category 1: quarterly-horizon timelines (decay/freeze interplay).

  test('10 quarterly-distant semantic fact survives decay and noise', async () => {
    await evaluateQuestion({
      id: '10',
      title: 'quarterly distant recall',
      booklet: 'm4',
      expected: 'pass',
    }, async ({ criterion }) => {
      const query = 'auth token strategy decision';
      const queryVector = basis(30);
      registerQueryVector(query, queryVector);

      const oldFactId = addFact({
        subject: 'AuthArchitecture',
        predicate: 'chose token strategy',
        object: 'stateless JWT with refresh rotation',
        embedding: queryVector,
        createdAt: '2025-12-01T09:00:00.000Z',
      });

      const noiseMonths = ['2025-12', '2026-01', '2026-02'];
      for (let i = 0; i < 120; i++) {
        addFact({
          subject: `QuarterNoise${i}`,
          predicate: 'mentions',
          object: `interim implementation note ${i}`,
          embedding: basis(100 + i),
          createdAt: `${noiseMonths[i % 3]}-${String((i % 27) + 1).padStart(2, '0')}T09:00:00.000Z`,
        });
      }

      await runDecaySweep(QUARTERLY_DECAY_CONFIG);

      const oldFact = dbState.db.prepare('SELECT heat, decay_bucket FROM facts WHERE id = ?').get(oldFactId);
      const rows = await searchRows(query, 5);
      criterion('appear', 'quarterly-old semantic fact is still retrieved through 120 noise facts', hasFact(rows, { object_text: 'stateless JWT with refresh rotation' }), rows.map(row => row.object_text));
      criterion('appear', 'semantic floor keeps the quarterly-old fact from evaporating', oldFact.heat >= 0.299, oldFact);
    });
  });

  test('11 frozen dormant project keeps memory heat intact while active projects decay', async () => {
    await evaluateQuestion({
      id: '11',
      title: 'project freeze at quarterly horizon',
      booklet: 'm4',
      expected: 'pass',
    }, async ({ criterion }) => {
      const query = 'dormant pipeline blocker';
      const queryVector = basis(31);
      registerQueryVector(query, queryVector);

      const frozenFactId = addFact({
        subject: 'DormantPipeline',
        predicate: 'currently blocks',
        object: 'nightly export job',
        factType: 'state',
        projectId: 'memora-frozen-project',
        embedding: queryVector,
        createdAt: '2026-01-01T09:00:00.000Z',
        heat: 1.0,
        baseHeat: 1.0,
      });
      const activeFactId = addFact({
        subject: 'ActivePipeline',
        predicate: 'currently blocks',
        object: 'weekly import job',
        factType: 'state',
        projectId: 'memora-active-project',
        embedding: basis(32),
        createdAt: '2026-01-01T09:00:00.000Z',
        heat: 1.0,
        baseHeat: 1.0,
      });

      // Freeze detection compares projects.last_active_at against SQLite's
      // real clock (datetime('now')), which fake timers do not reach — pin
      // both projects to extreme dates so the fixture stays deterministic.
      dbState.db.prepare('UPDATE projects SET last_active_at = ? WHERE id = ?')
        .run('2000-01-01T00:00:00.000Z', 'memora-frozen-project');
      dbState.db.prepare('UPDATE projects SET last_active_at = ? WHERE id = ?')
        .run('9999-01-01T00:00:00.000Z', 'memora-active-project');

      await runDecaySweep({
        worker: { decay: { ...QUARTERLY_DECAY_CONFIG.worker.decay, freezeAfterInactiveDays: 7 } },
      });

      const frozenFact = dbState.db.prepare('SELECT heat FROM facts WHERE id = ?').get(frozenFactId);
      const activeFact = dbState.db.prepare('SELECT heat FROM facts WHERE id = ?').get(activeFactId);
      const rows = await searchRows(query, 5, 'memora-frozen-project');

      criterion('appear', 'dormant project fact keeps full heat under freeze', frozenFact.heat >= 0.999, frozenFact);
      criterion('appear', 'dormant project fact is still retrievable on revival', hasFact(rows, { object_text: 'nightly export job' }), rows.map(row => row.object_text));
      criterion('forget', 'same-age fact in an active project decays to the state floor', activeFact.heat <= 0.051, activeFact);
    });
  });

  test('12 type-aware half-lives hold at the quarterly horizon', async () => {
    await evaluateQuestion({
      id: '12',
      title: 'quarterly type-aware decay',
      booklet: 'm4',
      expected: 'pass',
    }, async ({ criterion }) => {
      addFact({
        subject: 'DataModel',
        predicate: 'documents invariant',
        object: 'facts are append-only with a status lifecycle',
        embedding: basis(33),
        createdAt: '2025-12-07T09:00:00.000Z',
      });
      const staleStateId = addFact({
        subject: 'LegacyIncident',
        predicate: 'currently blocks',
        object: 'v0 importer rollout',
        factType: 'state',
        embedding: basis(34),
        createdAt: '2025-12-07T09:00:00.000Z',
        heat: 1.0,
        baseHeat: 1.0,
      });
      for (let i = 0; i < 3; i++) {
        addFact({
          subject: `FreshOps${i}`,
          predicate: 'tracks',
          object: `current rollout guard ${i}`,
          factType: 'state',
          embedding: basis(40 + i),
          createdAt: '2026-03-06T09:00:00.000Z',
          heat: 1.0,
          baseHeat: 1.0,
        });
      }

      await runDecaySweep(QUARTERLY_DECAY_CONFIG);

      const staleState = dbState.db.prepare('SELECT heat, decay_bucket FROM facts WHERE id = ?').get(staleStateId);
      const brief = briefRows({ maxFacts: 4 });

      criterion('appear', 'quarterly-old semantic fact still reaches the brief via its floor', hasFact(brief, { subject: 'DataModel' }), brief.map(row => row.subject));
      criterion('appear', 'fresh state facts fill the remaining brief slots', brief.filter(row => row.subject.startsWith('FreshOps')).length === 3, brief.map(row => row.subject));
      criterion('forget', 'quarterly-old state fact reaches the cold floor and stays out of the brief', staleState.heat <= 0.051 && staleState.decay_bucket === 'cold' && !hasFact(brief, { subject: 'LegacyIncident' }), {
        briefSubjects: brief.map(row => row.subject),
        staleState,
      });
    });
  });

  // Category 2: batch refactor pressure — A1 (repo grounding) acceptance
  // questions. Red until a repo-grounded validation sweep exists; assertions
  // anchor the end state (stale path facts retired), not any future API shape.

  test('13 batch directory refactor retires every stale path fact (A1)', async () => {
    await evaluateQuestion({
      id: '13',
      title: 'batch directory refactor',
      booklet: 'm4',
      expected: 'pass',
    }, async ({ criterion }) => {
      const files = ['auth.js', 'db.js', 'http.js', 'cache.js'];
      const pathFactIds = files.map((file, i) => addFact({
        subject: `src/legacy/${file}`,
        predicate: 'contains',
        object: `${file.replace('.js', '')} module implementation`,
        embedding: basis(60 + i),
        createdAt: '2026-02-10T09:00:00.000Z',
      }));

      const query = 'where did the legacy modules move';
      const queryVector = basis(64);
      registerQueryVector(query, queryVector);
      addFact({
        subject: 'src/core',
        predicate: 'now hosts the legacy modules',
        object: 'moved from src/legacy',
        operation: 'move',
        from: 'src/legacy',
        to: 'src/core',
        confidence: 0.9,
        embedding: queryVector,
        createdAt: '2026-03-06T09:00:00.000Z',
      });

      // Repo ground truth: the whole directory was renamed — git reports it
      // as one rename per file.
      setProjectRoot();
      await runGroundingSweep({
        renames: files.map(file => ({ from: `src/legacy/${file}`, to: `src/core/${file}` })),
        missingPaths: files.map(file => `src/legacy/${file}`),
      });

      const rows = await searchRows(query, 5);
      criterion('appear', 'the relocation announcement is retrievable', hasFact(rows, { object_text: 'moved from src/legacy' }), rows.map(row => row.object_text));
      for (let i = 0; i < files.length; i++) {
        const fact = dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(pathFactIds[i]);
        criterion('forget', `stale path fact src/legacy/${files[i]} is retired after the directory refactor`, fact.status !== 'active', fact);
      }
      const newEntity = dbState.db.prepare("SELECT aliases_json FROM entities WHERE canonical_name = 'src/core/auth.js'").get();
      const aliases = JSON.parse(newEntity?.aliases_json || '[]');
      criterion('appear', 'the new path entity carries the old path as an alias', aliases.includes('src/legacy/auth.js'), aliases);
    });
  });

  test('14 silent file removal retires the stale doc-path fact after confirmation (A1)', async () => {
    await evaluateQuestion({
      id: '14',
      title: 'silent removal with two-sweep confirmation',
      booklet: 'm4',
      expected: 'pass',
    }, async ({ criterion }) => {
      // Cold-start search on a topic memory has never seen: the honest answer
      // is zero rows, and the empty-search behavior metric records it.
      const coldQuery = 'getting started guide path';
      registerQueryVector(coldQuery, basis(72));
      const coldRows = await searchRows(coldQuery, 5);
      criterion('appear', 'unknown topic yields an honest empty result instead of a fabricated one', coldRows.length === 0, coldRows.map(row => row.object_text));

      const renamedFactId = addFact({
        subject: 'docs/setup.md',
        predicate: 'documents',
        object: 'installation flow',
        embedding: basis(70),
        createdAt: '2026-02-05T09:00:00.000Z',
      });
      const controlFactId = addFact({
        subject: 'docs/api.md',
        predicate: 'documents',
        object: 'HTTP endpoint reference',
        embedding: basis(71),
        createdAt: '2026-02-05T09:00:00.000Z',
      });

      // Repo ground truth: docs/setup.md is gone with no conversational trace
      // and no rename record to follow (e.g. squashed history) — the missing
      // flow backstops, with two-sweep confirmation against branch-switch
      // false kills.
      setProjectRoot();
      const missingSnapshot = { renames: [], missingPaths: ['docs/setup.md'] };
      await runGroundingSweep(missingSnapshot, NOW_ISO);

      const afterFirst = dbState.db.prepare('SELECT status, missing_since FROM facts WHERE id = ?').get(renamedFactId);
      criterion('appear', 'first detection only marks the fact, no premature kill', afterFirst.status === 'active' && afterFirst.missing_since !== null, afterFirst);

      await runGroundingSweep(missingSnapshot, '2026-03-07T19:00:00.000Z');

      const renamed = dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(renamedFactId);
      const control = dbState.db.prepare('SELECT status, missing_since FROM facts WHERE id = ?').get(controlFactId);
      criterion('appear', 'untouched doc fact stays active and unmarked', control.status === 'active' && control.missing_since === null, control);
      criterion('forget', 'silently removed doc-path fact is retired after the second confirmation', renamed.status !== 'active', renamed);
    });
  });

  // Category 3: multi-entity alias chains.

  test('15 chained rename A→B→C consolidates aliases and retires stale paths', async () => {
    await evaluateQuestion({
      id: '15',
      title: 'alias chain across two renames',
      booklet: 'm4',
      expected: 'pass',
    }, async ({ criterion }) => {
      const originalId = addFact({
        subject: 'src/utils/format.js',
        predicate: 'contains',
        object: 'currency formatter',
        embedding: basis(80),
        createdAt: '2026-02-01T09:00:00.000Z',
      });
      const firstMoveId = addFact({
        subject: 'src/lib/format.js',
        predicate: 'now contains',
        object: 'currency formatter',
        operation: 'move',
        from: 'src/utils/format.js',
        to: 'src/lib/format.js',
        confidence: 0.9,
        embedding: basis(81),
        createdAt: '2026-02-20T09:00:00.000Z',
      });
      const query = 'currency formatter file location';
      const queryVector = basis(82);
      registerQueryVector(query, queryVector);
      addFact({
        subject: 'src/money/format.js',
        predicate: 'now contains',
        object: 'currency formatter',
        operation: 'move',
        from: 'src/lib/format.js',
        to: 'src/money/format.js',
        confidence: 0.9,
        embedding: queryVector,
        createdAt: '2026-03-05T09:00:00.000Z',
      });

      const rows = await searchRows(query, 5);
      const original = dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(originalId);
      const firstMove = dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(firstMoveId);
      const finalEntity = dbState.db.prepare("SELECT aliases_json FROM entities WHERE canonical_name = 'src/money/format.js'").get();
      const aliases = JSON.parse(finalEntity?.aliases_json || '[]');

      criterion('appear', 'final path fact is retrievable', hasFact(rows, { subject: 'src/money/format.js' }), rows.map(row => row.subject));
      criterion('appear', 'final entity carries both prior names as aliases', aliases.includes('src/utils/format.js') && aliases.includes('src/lib/format.js'), aliases);
      criterion('forget', 'original path fact is retired by the first move', original.status !== 'active', original);
      criterion('forget', 'intermediate path fact is retired by the second move', firstMove.status !== 'active', firstMove);
    });
  });

  test('16 alias-aware full retrieval resolves a renamed entity (G9)', async () => {
    await evaluateQuestion({
      id: '16',
      title: 'alias-aware full-subject retrieval',
      booklet: 'm4',
      expected: 'pass',
    }, async ({ criterion }) => {
      addFact({
        subject: 'src/old/telemetry.js',
        predicate: 'contains',
        object: 'span exporter',
        embedding: basis(85),
        createdAt: '2026-02-01T09:00:00.000Z',
      });
      addFact({
        subject: 'src/obs/telemetry.js',
        predicate: 'now contains',
        object: 'span exporter',
        operation: 'move',
        from: 'src/old/telemetry.js',
        to: 'src/obs/telemetry.js',
        confidence: 0.9,
        embedding: basis(86),
        createdAt: '2026-02-20T09:00:00.000Z',
      });
      addFact({
        subject: 'src/obs/telemetry.js',
        predicate: 'exports',
        object: 'OTLP batching helper',
        embedding: basis(87),
        createdAt: '2026-03-01T09:00:00.000Z',
      });

      const about = await loadMemoryAbout();
      if (!about) {
        criterion('appear', 'memory_about seam available (G9)', false, 'module src/mcp/memory-about.js not implemented yet');
        return;
      }
      const rows = about.selectMemoryAboutRows(dbState.db, { subject: 'src/old/telemetry.js', projectId: PROJECT_ID });
      criterion('appear', 'the old name resolves via alias to the current entity facts', rows.length >= 2 && rows.some(row => row.object_text === 'OTLP batching helper'), rows.map(row => `${row.predicate} ${row.object_text}`));
      criterion('forget', 'the superseded old-path fact is not included', !rows.some(row => row.predicate === 'contains' && row.object_text === 'span exporter'), rows.map(row => `${row.predicate} ${row.object_text}`));
    });
  });

  // Category 4: full-subject completeness — G9 acceptance questions.

  test('17 full-subject retrieval is complete under mutation (G9)', async () => {
    await evaluateQuestion({
      id: '17',
      title: 'full-subject completeness beyond top-k',
      booklet: 'm4',
      expected: 'pass',
    }, async ({ criterion }) => {
      const attributes = [
        ['listens on port', '8443'],
        ['authenticates via', 'mTLS client certs'],
        ['retry limit', '3'],
        ['persists ledger in', 'payments.sqlite'],
        ['emits metrics to', 'statsd on 8125'],
        ['depends on', 'stripe SDK v14'],
        ['deploys from', 'payments-deploy pipeline'],
        ['owned by', 'billing team'],
        ['rate limits at', '200 rps per key'],
        ['stores secrets in', 'vault kv/payments'],
        ['health check at', '/internal/healthz'],
        ['logs to', 'payments.log with pino'],
      ];
      attributes.forEach(([predicate, object], i) => addFact({
        subject: 'PaymentsService',
        predicate,
        object,
        embedding: basis(90 + i),
        createdAt: `2026-02-${String(i + 1).padStart(2, '0')}T09:00:00.000Z`,
      }));
      addFact({
        subject: 'PaymentsService',
        predicate: 'retry limit',
        object: '5',
        operation: 'update',
        confidence: 0.9,
        embedding: pairedVector(92, 0.85),
        createdAt: '2026-03-03T09:00:00.000Z',
      });

      const about = await loadMemoryAbout();
      if (!about) {
        criterion('appear', 'memory_about seam available (G9)', false, 'module src/mcp/memory-about.js not implemented yet');
        return;
      }
      const rows = about.selectMemoryAboutRows(dbState.db, { subject: 'PaymentsService', projectId: PROJECT_ID });
      criterion('appear', 'every active fact about the subject is returned (beyond default top-k)', rows.length === 12, rows.length);
      criterion('appear', 'the updated retry limit is present', rows.some(row => row.predicate === 'retry limit' && row.object_text === '5'), rows.filter(row => row.predicate === 'retry limit').map(row => row.object_text));
      criterion('forget', 'the superseded retry limit is excluded', !rows.some(row => row.predicate === 'retry limit' && row.object_text === '3'), rows.filter(row => row.predicate === 'retry limit').map(row => row.object_text));
    });
  });

  test('18 multi-valued predicate facts coexist and are fully retrievable (G13/G9)', async () => {
    await evaluateQuestion({
      id: '18',
      title: 'multi-valued predicate completeness',
      booklet: 'm4',
      expected: 'pass',
    }, async ({ criterion }) => {
      const envVars = ['DEPLOY_KEY', 'DEPLOY_REGION', 'DEPLOY_BUCKET', 'DEPLOY_ROLE', 'DEPLOY_TIMEOUT', 'DEPLOY_CHANNEL'];
      // Pairwise cosine pinned at 0.85 — inside the compaction conflict band
      // (0.75–0.92), deliberately below the >0.92 merge band, which has its
      // own open question for multi-valued groups (see gap analysis).
      const factIds = envVars.map((name, i) => addFact({
        subject: 'DeployPipeline',
        predicate: 'requires env var',
        object: `${name} set`,
        embedding: vector([[50, Math.sqrt(0.85)], [51 + i, Math.sqrt(0.15)]]),
        createdAt: `2026-02-${String(i + 1).padStart(2, '0')}T09:00:00.000Z`,
      }));

      const statuses = factIds.map(id => dbState.db.prepare('SELECT status FROM facts WHERE id = ?').get(id).status);
      criterion('appear', 'complementary same-predicate facts all stay active (no false supersede)', statuses.every(status => status === 'active'), statuses);

      await runCompactionSweep(dbState.db, {}, QUARTERLY_DECAY_CONFIG.worker.decay);
      const afterCompaction = factIds.map(id => dbState.db.prepare('SELECT status, heat FROM facts WHERE id = ?').get(id));
      criterion('appear', 'compaction leaves the complementary group active and undemoted', afterCompaction.every(row => row.status === 'active' && row.heat >= 0.699), afterCompaction);

      const about = await loadMemoryAbout();
      if (!about) {
        criterion('appear', 'memory_about seam available (G9)', false, 'module src/mcp/memory-about.js not implemented yet');
        return;
      }
      const rows = about.selectMemoryAboutRows(dbState.db, { subject: 'DeployPipeline', projectId: PROJECT_ID });
      criterion('appear', 'full-subject mode returns every required env var', envVars.every(name => rows.some(row => row.object_text === `${name} set`)), rows.map(row => row.object_text));
    });
  });

  // Category 5: reasoning — retrieval-completeness proxy plus real SQL
  // aggregation through the sql_readonly sandbox.

  test('19 scattered numeric facts are fully retrievable and aggregate via SQL', async () => {
    await evaluateQuestion({
      id: '19',
      title: 'scattered numeric aggregation',
      booklet: 'm4',
      expected: 'pass',
    }, async ({ criterion }) => {
      const query = 'ci minutes usage';
      const queryVector = basis(95);
      registerQueryVector(query, queryVector);

      const weeks = [['week1 usage', '1200'], ['week2 usage', '950'], ['week3 usage', '1430'], ['week4 usage', '1010']];
      weeks.forEach(([predicate, object], i) => addFact({
        subject: 'CIMinutes',
        predicate,
        object,
        embedding: queryVector,
        createdAt: `2026-02-${String((i + 1) * 7).padStart(2, '0')}T09:00:00.000Z`,
      }));
      // A repeated observation of the same fact must dedup, not double-count
      // in the aggregate below (repeat-write behavior metric).
      addFact({
        subject: 'CIMinutes',
        predicate: 'week2 usage',
        object: '950',
        embedding: queryVector,
        createdAt: '2026-03-01T09:00:00.000Z',
        allowDedup: true,
      });

      const rows = await searchRows(query, 5);
      for (const [predicate, object] of weeks) {
        criterion('appear', `${predicate} is retrievable`, hasFact(rows, { predicate, object_text: object }), rows.map(row => `${row.predicate} ${row.object_text}`));
      }

      const table = sqlReadonly({
        sql: `SELECT SUM(CAST(object_text AS INTEGER)) AS total_minutes FROM facts WHERE project_id = '${PROJECT_ID}' AND predicate LIKE 'week% usage' AND status = 'active'`,
      }, { maxRows: 10 });
      criterion('appear', 'sql_readonly aggregates the scattered values to the correct total', table.includes('| 4590 |'), table);
    });
  });

  test('20 SQL aggregation reflects mutation and excludes the superseded value', async () => {
    await evaluateQuestion({
      id: '20',
      title: 'aggregation over mutated facts',
      booklet: 'm4',
      expected: 'pass',
    }, async ({ criterion }) => {
      const query = 'api monthly budget limit';
      const queryVector = basis(99);
      registerQueryVector(query, queryVector);

      addFact({
        subject: 'ApiBudget',
        predicate: 'monthly limit',
        object: '500',
        embedding: queryVector,
        createdAt: '2026-02-01T09:00:00.000Z',
      });
      addFact({
        subject: 'ApiBudget',
        predicate: 'monthly limit',
        object: '800',
        operation: 'update',
        confidence: 0.9,
        embedding: pairedVector(99, 0.85),
        createdAt: '2026-03-01T09:00:00.000Z',
      });

      const rows = await searchRows(query, 5);
      criterion('appear', 'the updated budget is retrievable', hasFact(rows, { object_text: '800' }), rows.map(row => row.object_text));
      criterion('forget', 'the superseded budget does not reappear in search', !hasFact(rows, { object_text: '500' }), rows.map(row => row.object_text));

      const table = sqlReadonly({
        sql: `SELECT object_text FROM facts WHERE project_id = '${PROJECT_ID}' AND predicate = 'monthly limit' AND status = 'active'`,
      }, { maxRows: 10 });
      criterion('appear', 'SQL over active facts sees the updated value', table.includes('| 800 |'), table);
      criterion('forget', 'SQL over active facts excludes the superseded value', !table.includes('| 500 |'), table);
    });
  });
});

describe.skipIf(sqliteVecProbe.loaded)('memora mini-FAMA sqlite-vec fallback notice', () => {
  test('sqlite-vec load failure leaves only text-path tests runnable', () => {
    expect(sqliteVecProbe.loaded, sqliteVecProbe.error?.message).toBe(false);
  });
});
