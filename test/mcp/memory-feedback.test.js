import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMemoryTestDb, seedMemoryFact } from './memory-fixtures.js';

const dbState = vi.hoisted(() => ({ db: null }));

vi.mock('../../src/shared/db.js', () => ({
  getDb: () => dbState.db,
  isVecEnabled: () => false,
}));

vi.mock('../../src/shared/config.js', () => ({
  loadConfig: () => ({
    worker: {
      decay: {
        floorByType: { semantic: 0.3, preference: 0.7 },
      },
    },
  }),
}));

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

const { memoryFeedback } = await import('../../src/mcp/memory-feedback.js');

function factRow(id) {
  return dbState.db.prepare(
    'SELECT status, heat, base_heat, last_accessed_at, missing_since FROM facts WHERE id = ?'
  ).get(id);
}

function feedbackAudits() {
  return dbState.db.prepare("SELECT target_id, detail_json FROM audit_logs WHERE action = 'feedback'")
    .all()
    .map(row => ({ targetId: row.target_id, detail: JSON.parse(row.detail_json) }));
}

describe('memoryFeedback', () => {
  beforeEach(() => {
    dbState.db = createMemoryTestDb();
  });

  afterEach(() => {
    dbState.db?.close();
    dbState.db = null;
  });

  it('stale halves heat and base_heat down to the type floor and writes an audit row', () => {
    seedMemoryFact(dbState.db, {
      id: 'fact_stale_target',
      subject: 'BuildTool',
      predicate: 'uses bundler',
      object: 'webpack',
      heat: 1.0,
    });

    const result = memoryFeedback({
      verdict: 'stale',
      subject: 'BuildTool',
      object: 'webpack',
      reason: 'vite.config.ts is in the repo, no webpack config anywhere',
      project_id: 'proj1',
    });

    expect(result).toContain('Marked 1 fact(s) stale');
    const row = factRow('fact_stale_target');
    expect(row.status).toBe('active');
    expect(row.heat).toBe(0.5);
    expect(row.base_heat).toBe(0.5);

    const audits = feedbackAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].targetId).toBe('fact_stale_target');
    expect(audits[0].detail.verdict).toBe('stale');
    expect(audits[0].detail.reason).toContain('vite.config.ts');
  });

  it('repeated stale calls keep halving but stop at the type floor', () => {
    seedMemoryFact(dbState.db, {
      id: 'fact_floor',
      subject: 'Core',
      predicate: 'written in',
      object: 'CoffeeScript',
      factType: 'semantic',
      heat: 1.0,
    });

    for (let i = 0; i < 4; i++) {
      memoryFeedback({ verdict: 'stale', subject: 'Core', object: 'CoffeeScript', project_id: 'proj1' });
    }

    expect(factRow('fact_floor').heat).toBe(0.3); // semantic floor from config
  });

  it('confirmed refreshes last_accessed_at and clears missing_since without touching heat', () => {
    seedMemoryFact(dbState.db, {
      id: 'fact_confirm',
      subject: 'src/app/router.ts',
      predicate: 'contains',
      object: 'route table',
      heat: 0.4,
    });
    dbState.db.prepare("UPDATE facts SET missing_since = '2026-03-01T00:00:00Z' WHERE id = 'fact_confirm'").run();

    const result = memoryFeedback({
      verdict: 'confirmed',
      subject: 'src/app/router.ts',
      project_id: 'proj1',
    });

    expect(result).toContain('Confirmed 1 fact(s)');
    const row = factRow('fact_confirm');
    expect(row.heat).toBe(0.4);
    expect(row.base_heat).toBe(0.4);
    expect(row.missing_since).toBeNull();
    expect(row.last_accessed_at).not.toBe('2026-03-07T10:00:00Z');
  });

  it('refuses to apply feedback when the match set exceeds the limit', () => {
    for (let i = 0; i < 6; i++) {
      seedMemoryFact(dbState.db, {
        id: `fact_broad_${i}`,
        subject: 'DeployPipeline',
        predicate: `requires env var ${i}`,
        object: `VAR_${i} set`,
        heat: 1.0,
      });
    }

    const result = memoryFeedback({ verdict: 'stale', subject: 'DeployPipeline', project_id: 'proj1' });

    expect(result).toContain('refusing to apply feedback');
    for (let i = 0; i < 6; i++) {
      expect(factRow(`fact_broad_${i}`).heat).toBe(1.0);
    }
    expect(feedbackAudits()).toHaveLength(0);
  });

  it('fact_id targets exactly one active fact and ignores retired ones', () => {
    seedMemoryFact(dbState.db, {
      id: 'fact_retired',
      subject: 'Legacy',
      predicate: 'uses',
      object: 'gulp',
      status: 'superseded',
      heat: 1.0,
    });

    expect(memoryFeedback({ verdict: 'stale', fact_id: 'fact_retired', project_id: 'proj1' }))
      .toBe('No matching active facts.');
  });

  it('rejects calls with no locating parameters', () => {
    expect(() => memoryFeedback({ verdict: 'stale', project_id: 'proj1' }))
      .toThrow(/fact_id or at least one/);
  });

  it('rejects unknown verdicts', () => {
    expect(() => memoryFeedback({ verdict: 'wrong', subject: 'X', project_id: 'proj1' }))
      .toThrow(/verdict must be/);
  });
});
