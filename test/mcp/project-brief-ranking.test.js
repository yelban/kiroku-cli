import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMemoryTestDb, seedMemoryFact } from './memory-fixtures.js';
import { selectProjectBriefRows } from '../../src/mcp/project-brief.js';

// G8 fixture: an old, heavily-retrieved preference vs a fresh replacement
// worded too differently for any supersede mechanism to catch.
function seedImmortalizationScenario(db) {
  seedMemoryFact(db, {
    id: 'pref_stale',
    projectId: 'global-proj',
    subject: 'user',
    predicate: 'prefers installing with',
    object: 'npm',
    factType: 'preference',
    heat: 1.0,
    accessCount: 20,
    scope: 'global',
    createdAt: '2026-01-05T09:00:00Z',
  });
  seedMemoryFact(db, {
    id: 'pref_fresh',
    projectId: 'global-proj',
    subject: 'user',
    predicate: 'installs packages via',
    object: 'bun --bun',
    factType: 'preference',
    heat: 0.7,
    scope: 'global',
    createdAt: '2026-03-06T09:00:00Z',
  });
}

describe('selectProjectBriefRows within-type ranking (G8)', () => {
  let db;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-07T12:00:00.000Z'));
    db = createMemoryTestDb();
    seedImmortalizationScenario(db);
  });

  afterEach(() => {
    db?.close();
    vi.useRealTimers();
  });

  it('default ranking lets the fresh preference outrank the boost-stacked stale one', () => {
    const rows = selectProjectBriefRows(db, 'proj1', { maxFacts: 2 });

    expect(rows.map(row => row.fact_id)).toEqual(['pref_fresh', 'pref_stale']);
  });

  it('recencyWeight 0 restores the legacy ordering including the access multiplier', () => {
    const rows = selectProjectBriefRows(db, 'proj1', {
      maxFacts: 2,
      ranking: { recencyWeight: 0 },
    });

    // Legacy score: stale 1.0×(1+20×0.1)=3.0 vs fresh 0.7×1=0.7.
    expect(rows.map(row => row.fact_id)).toEqual(['pref_stale', 'pref_fresh']);
  });

  it('equal scores keep the coarse order (stable tie-break)', () => {
    seedMemoryFact(db, {
      id: 'sem_a',
      projectId: 'proj1',
      subject: 'CoreA',
      predicate: 'defines',
      object: 'invariant a',
      heat: 0.8,
      createdAt: '2026-03-01T09:00:00Z',
    });
    seedMemoryFact(db, {
      id: 'sem_b',
      projectId: 'proj1',
      subject: 'CoreB',
      predicate: 'defines',
      object: 'invariant b',
      heat: 0.8,
      createdAt: '2026-03-01T09:00:00Z',
    });

    const rows = selectProjectBriefRows(db, 'proj1', { maxFacts: 10 });
    const semantics = rows.filter(row => row.fact_type === 'semantic').map(row => row.fact_id);
    expect(semantics).toEqual(['sem_a', 'sem_b']);
  });
});
