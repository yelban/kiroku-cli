import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryTestDb, seedMemoryFact } from './memory-fixtures.js';

const dbState = vi.hoisted(() => ({
  db: null,
}));

const storeMocks = vi.hoisted(() => ({
  setDb: vi.fn(),
  boostFactHeat: vi.fn(),
}));

vi.mock('../../src/shared/db.js', () => ({
  getDb: () => dbState.db,
  isVecEnabled: () => false,
}));

vi.mock('../../src/shared/config.js', () => ({
  loadConfig: () => ({
    mcp: {
      search: {
        ranking: {
          simWeight: 0.65,
          heatWeight: 0.15,
          recencyWeight: 0.2,
          halfLifeDays: 30,
        },
      },
    },
  }),
}));

vi.mock('../../src/worker/store.js', () => ({
  setDb: storeMocks.setDb,
  boostFactHeat: storeMocks.boostFactHeat,
}));

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const { memorySearch, renderMemorySearchRows } = await import('../../src/mcp/memory-search.js');
const { renderProjectBriefRows } = await import('../../src/mcp/project-brief.js');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days) {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

function briefRow(overrides) {
  return {
    fact_type: 'semantic',
    subject: 'Project',
    predicate: 'uses',
    object_text: 'SQLite',
    object_detail: null,
    scope: 'project',
    ...overrides,
  };
}

function searchRow(overrides = {}) {
  return {
    subject: 'Project',
    predicate: 'uses',
    object_text: 'SQLite',
    object_detail: null,
    fact_type: 'semantic',
    confidence: 0.9,
    scope: 'project',
    created_at: '2026-03-07T10:11:12Z',
    ...overrides,
  };
}

describe('freshness render metadata', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
    storeMocks.setDb.mockClear();
    storeMocks.boostFactHeat.mockClear();
  });

  afterEach(() => {
    dbState.db?.close();
    dbState.db = null;
    vi.useRealTimers();
  });

  it('renders project brief age markers at day, week, and month boundaries', () => {
    const result = renderProjectBriefRows([
      briefRow({ subject: 'Thirteen', object_text: 'days old', created_at: daysAgo(13) }),
      briefRow({ subject: 'Fourteen', object_text: 'days old', created_at: daysAgo(14) }),
      briefRow({ subject: 'SixtyNine', object_text: 'days old', created_at: daysAgo(69) }),
      briefRow({ subject: 'Seventy', object_text: 'days old', created_at: daysAgo(70) }),
    ]);

    expect(result).toBe(`# Project Memory Brief (4 facts)

[semantic] Thirteen uses days old (13d)
[semantic] Fourteen uses days old (2w)
[semantic] SixtyNine uses days old (10w)
[semantic] Seventy uses days old (2mo)`);
  });

  it('omits project brief age markers when created_at is missing or invalid', () => {
    const result = renderProjectBriefRows([
      briefRow({ subject: 'Missing', object_text: 'timestamp' }),
      briefRow({ subject: 'Invalid', object_text: 'timestamp', created_at: 'not-a-date' }),
    ]);

    expect(result).toBe(`# Project Memory Brief (2 facts)

[semantic] Missing uses timestamp
[semantic] Invalid uses timestamp`);
  });

  it('renders historical memory search warning and Status column for non-active status', () => {
    const result = renderMemorySearchRows([
      searchRow({ subject: 'Legacy', object_text: 'old state' }),
    ], 'superseded');

    expect(result).toBe(`**⚠ Historical facts (status=superseded) — NOT current state**

| Subject | Predicate | Object | Type | Scope | Status | Conf | Date |
|---|---|---|---|---|---|---|---|
| Legacy | uses | old state | semantic | project | superseded | 0.9 | 2026-03-07 |

_1 results_`);
  });

  it('keeps active memory search output without a Status column', () => {
    const result = renderMemorySearchRows([
      searchRow({ subject: 'Current', object_text: 'current state' }),
    ]);

    expect(result).toBe(`| Subject | Predicate | Object | Type | Scope | Conf | Date |
|---|---|---|---|---|---|---|
| Current | uses | current state | semantic | project | 0.9 | 2026-03-07 |

_1 results_`);
    expect(result).not.toContain('Status');
    expect(result).not.toContain('Historical facts');
  });

  it('passes non-active query status through memorySearch rendering', async () => {
    dbState.db = createMemoryTestDb();
    seedMemoryFact(dbState.db, {
      id: 'fact_legacy_state',
      projectId: 'proj1',
      subject: 'Legacy',
      predicate: 'uses',
      object: 'old state',
      status: 'superseded',
      createdAt: '2026-01-01T00:00:00Z',
    });

    const result = await memorySearch({
      query: 'old',
      project_id: 'proj1',
      top_k: 10,
      scope: 'project',
      status: 'superseded',
    });

    expect(result).toContain('**⚠ Historical facts (status=superseded) — NOT current state**');
    expect(result).toContain('| Subject | Predicate | Object | Type | Scope | Status | Conf | Date |');
    expect(result).toContain('| Legacy | uses | old state | semantic | project | superseded | 1 | 2026-01-01 |');
  });
});
