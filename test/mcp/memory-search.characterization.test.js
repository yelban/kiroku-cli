import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMemoryTestDb, seedMemoryFact } from './memory-fixtures.js';

const dbState = vi.hoisted(() => ({ db: null }));
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
  isVecEnabled: () => false,
}));

vi.mock('../../src/worker/store.js', () => ({
  setDb: storeMocks.setDb,
  boostFactHeat: storeMocks.boostFactHeat,
}));

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => loggerMock,
}));

const {
  memorySearch,
  renderMemorySearchRows,
  selectMemorySearchRows,
} = await import('../../src/mcp/memory-search.js');

function seedSearchScenario(db) {
  seedMemoryFact(db, {
    id: 'fact_project_sqlite',
    projectId: 'proj1',
    subject: 'Project|Alpha',
    predicate: 'uses',
    object: 'SQLite\nfor memory',
    detail: 'Fast local store',
    factType: 'semantic',
    confidence: 0.82,
    heat: 0.9,
    scope: 'project',
    createdAt: '2026-03-07T10:11:12Z',
  });
  seedMemoryFact(db, {
    id: 'fact_global_bun',
    projectId: 'global-proj',
    subject: 'User',
    predicate: 'prefers',
    object: 'Bun runtime',
    factType: 'preference',
    confidence: 0.95,
    heat: 0.8,
    scope: 'global',
    createdAt: '2026-02-01T09:00:00Z',
  });
  seedMemoryFact(db, {
    id: 'fact_irrelevant',
    projectId: 'proj1',
    subject: 'Other',
    predicate: 'uses',
    object: 'unmatched value',
    factType: 'semantic',
    confidence: 0.7,
    heat: 1,
    scope: 'project',
    createdAt: '2026-04-01T00:00:00Z',
  });
}

const expectedSearchMarkdown = `| Subject | Predicate | Object | Type | Scope | Conf | Date |
|---|---|---|---|---|---|---|
| Project\\|Alpha | uses | SQLite for memory | semantic | project | 0.82 | 2026-03-07 |
| User | prefers | Bun runtime | preference | global | 0.95 | 2026-02-01 |

**Details:**
- **Project|Alpha** uses: Fast local store

_2 results_`;

describe('memorySearch characterization', () => {
  beforeEach(() => {
    dbState.db = createMemoryTestDb();
    storeMocks.setDb.mockClear();
    storeMocks.boostFactHeat.mockClear();
    loggerMock.debug.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.info.mockClear();
    loggerMock.error.mockClear();
  });

  afterEach(() => {
    dbState.db?.close();
    dbState.db = null;
  });

  it('preserves the current markdown output for text search results', async () => {
    seedSearchScenario(dbState.db);

    const result = await memorySearch({
      query: 'SQLite Bun',
      project_id: 'proj1',
      top_k: 10,
      scope: 'all',
    });

    expect(result).toBe(expectedSearchMarkdown);
  });

  it('returns structured rows before markdown rendering', async () => {
    seedSearchScenario(dbState.db);

    const rows = await selectMemorySearchRows({
      query: 'SQLite Bun',
      project_id: 'proj1',
      top_k: 10,
      scope: 'all',
    });

    expect(rows).toEqual([
      expect.objectContaining({
        fact_id: 'fact_project_sqlite',
        project_id: 'proj1',
        subject: 'Project|Alpha',
        predicate: 'uses',
        object_text: 'SQLite\nfor memory',
        object_detail: 'Fast local store',
        fact_type: 'semantic',
        confidence: 0.82,
        scope: 'project',
        created_at: '2026-03-07T10:11:12Z',
        heat: 0.9,
        access_count: 0,
      }),
      expect.objectContaining({
        fact_id: 'fact_global_bun',
        project_id: 'global-proj',
        subject: 'User',
        predicate: 'prefers',
        object_text: 'Bun runtime',
        object_detail: null,
        fact_type: 'preference',
        confidence: 0.95,
        scope: 'global',
        created_at: '2026-02-01T09:00:00Z',
        heat: 0.8,
        access_count: 0,
      }),
    ]);
    expect(renderMemorySearchRows(rows)).toBe(expectedSearchMarkdown);
  });

  it('preserves the current empty result message', async () => {
    const result = await memorySearch({
      query: 'nothing matches this',
      project_id: 'proj1',
      top_k: 10,
      scope: 'all',
    });

    expect(result).toBe('No matching facts found.');
  });
});
