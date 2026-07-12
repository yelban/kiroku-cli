import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryTestDb, seedMemoryFact } from './memory-fixtures.js';
import { selectProjectBriefRows } from '../../src/mcp/project-brief.js';

// G12 fixture: five hot global preferences vs three hot project semantics —
// under a tight budget the legacy absolute type priority filled every seat
// with preferences.
function seedQuotaScenario(db) {
  const prefs = [
    ['prefers shell', 'zsh'],
    ['prefers editor', 'helix'],
    ['prefers terminal', 'ghostty'],
    ['prefers vcs flow', 'trunk-based'],
    ['prefers docs tone', 'terse'],
  ];
  prefs.forEach(([predicate, object], i) => seedMemoryFact(db, {
    id: `pref_${i}`,
    projectId: 'global-proj',
    subject: 'user',
    predicate,
    object,
    factType: 'preference',
    heat: 1.0,
    scope: 'global',
  }));
  for (let i = 0; i < 3; i++) {
    seedMemoryFact(db, {
      id: `sem_${i}`,
      projectId: 'proj1',
      subject: 'Core',
      predicate: `defines invariant ${i}`,
      object: `write path guarantee ${i}`,
      factType: 'semantic',
      heat: 1.0,
      scope: 'project',
    });
  }
}

describe('selectProjectBriefRows type quotas (G12)', () => {
  let db;

  beforeEach(() => {
    db = createMemoryTestDb();
    seedQuotaScenario(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('keeps a semantic seat under a tight budget with the default floor', () => {
    const rows = selectProjectBriefRows(db, 'proj1', { maxFacts: 4 });

    expect(rows).toHaveLength(4);
    expect(rows[0].fact_type).toBe('preference');
    expect(rows.filter(row => row.fact_type === 'semantic')).toHaveLength(1);
  });

  it('minPerType 0 restores the legacy absolute-priority selector', () => {
    const rows = selectProjectBriefRows(db, 'proj1', { maxFacts: 4, minPerType: 0 });

    expect(rows).toHaveLength(4);
    expect(rows.every(row => row.fact_type === 'preference')).toBe(true);
  });

  it('a wide budget selects the same rows as the legacy selector', () => {
    const withFloor = selectProjectBriefRows(db, 'proj1', { maxFacts: 50 }).map(row => row.fact_id);
    const legacy = selectProjectBriefRows(db, 'proj1', { maxFacts: 50, minPerType: 0 }).map(row => row.fact_id);

    expect(withFloor).toEqual(legacy);
  });

  it('allocates floor seats in type-priority order when seats run out', () => {
    const rows = selectProjectBriefRows(db, 'proj1', { maxFacts: 1 });

    expect(rows).toHaveLength(1);
    expect(rows[0].fact_type).toBe('preference');
  });
});
