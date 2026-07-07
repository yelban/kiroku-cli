import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryTestDb, seedMemoryFact } from './memory-fixtures.js';

const dbState = vi.hoisted(() => ({
  db: null,
  vecEnabled: true,
}));

const configState = vi.hoisted(() => ({
  ranking: {
    simWeight: 0.65,
    heatWeight: 0.15,
    recencyWeight: 0.2,
    halfLifeDays: 30,
  },
}));

const storeMocks = vi.hoisted(() => ({
  setDb: vi.fn(),
  boostFactHeat: vi.fn(),
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
    mcp: {
      search: {
        ranking: configState.ranking,
      },
    },
  }),
}));

vi.mock('../../src/worker/embedder.js', () => ({
  initEmbedder: vi.fn(async () => {}),
  embedTexts: vi.fn(async texts => texts.map(() => Array(1024).fill(0))),
}));

vi.mock('../../src/worker/store.js', () => ({
  setDb: storeMocks.setDb,
  boostFactHeat: storeMocks.boostFactHeat,
}));

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => loggerMock,
}));

const { selectMemorySearchRows } = await import('../../src/mcp/memory-search.js');

function vectorDb(rows) {
  return {
    prepare: () => ({
      all: () => rows,
    }),
  };
}

function searchRow(overrides) {
  return {
    fact_id: overrides.fact_id,
    project_id: 'proj1',
    subject: overrides.subject ?? overrides.fact_id,
    predicate: 'uses cache policy',
    object_text: overrides.object_text ?? overrides.fact_id,
    object_detail: null,
    fact_type: 'semantic',
    confidence: 1,
    scope: 'project',
    created_at: overrides.created_at ?? '2026-03-07T10:00:00.000Z',
    heat: overrides.heat ?? 0.7,
    access_count: 0,
    distance: overrides.distance,
  };
}

async function selectRows(topK = 2) {
  return selectMemorySearchRows({
    query: 'ranking arbitration',
    project_id: 'proj1',
    top_k: topK,
    scope: 'project',
  });
}

describe('memory search ranking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
    configState.ranking = {
      simWeight: 0.65,
      heatWeight: 0.15,
      recencyWeight: 0.2,
      halfLifeDays: 30,
    };
    dbState.vecEnabled = true;
    dbState.db = null;
  });

  afterEach(() => {
    dbState.db?.close?.();
    dbState.db = null;
    vi.useRealTimers();
  });

  it('restores pure vector similarity order with ranking weights (1, 0, 0)', async () => {
    configState.ranking = {
      simWeight: 1,
      heatWeight: 0,
      recencyWeight: 0,
      halfLifeDays: 30,
    };
    dbState.db = vectorDb([
      searchRow({
        fact_id: 'old_closest',
        subject: 'OldClosest',
        object_text: 'legacy exact-match policy',
        distance: 0,
        heat: 0.1,
        created_at: '2026-01-10T10:00:00.000Z',
      }),
      searchRow({
        fact_id: 'fresh_warmer',
        subject: 'FreshWarmer',
        object_text: 'fresh heat-aware policy',
        distance: 0.03,
        heat: 1,
        created_at: '2026-03-07T10:00:00.000Z',
      }),
    ]);

    const rows = await selectRows();

    expect(rows.map(row => row.fact_id)).toEqual(['old_closest', 'fresh_warmer']);
  });

  it('ranks a newer hot vector fact first when similarity is slightly lower', async () => {
    dbState.db = vectorDb([
      searchRow({
        fact_id: 'old_closest',
        subject: 'OldClosest',
        object_text: 'legacy exact-match policy',
        distance: 0,
        heat: 0.2,
        created_at: '2026-01-10T10:00:00.000Z',
      }),
      searchRow({
        fact_id: 'fresh_warmer',
        subject: 'FreshWarmer',
        object_text: 'fresh heat-aware policy',
        distance: 0.03,
        heat: 1,
        created_at: '2026-03-07T10:00:00.000Z',
      }),
    ]);

    const rows = await selectRows();

    expect(rows.map(row => row.fact_id)).toEqual(['fresh_warmer', 'old_closest']);
  });

  it('reranks text-search candidates after SQL heat ordering and before diversity filtering', async () => {
    configState.ranking = {
      simWeight: 0,
      heatWeight: 0,
      recencyWeight: 1,
      halfLifeDays: 30,
    };
    dbState.vecEnabled = false;
    dbState.db = createMemoryTestDb();

    seedMemoryFact(dbState.db, {
      id: 'old_hot_text',
      projectId: 'proj1',
      subject: 'Policy',
      predicate: 'uses cache policy',
      object: 'cache policy state',
      heat: 1,
      createdAt: '2026-01-10T10:00:00.000Z',
    });
    seedMemoryFact(dbState.db, {
      id: 'fresh_cool_text',
      projectId: 'proj1',
      subject: 'Policy',
      predicate: 'uses cache policy',
      object: 'cache policy state',
      heat: 0.1,
      createdAt: '2026-03-07T10:00:00.000Z',
    });

    const rows = await selectMemorySearchRows({
      query: 'cache policy',
      project_id: 'proj1',
      top_k: 2,
      scope: 'project',
    });

    expect(rows.map(row => row.fact_id)).toEqual(['fresh_cool_text']);
  });
});
