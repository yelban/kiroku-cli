import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryTestDb, seedMemoryFact } from './memory-fixtures.js';
import {
  getProjectBrief,
  renderProjectBriefRows,
  selectProjectBriefRows,
} from '../../src/mcp/project-brief.js';

function seedBriefScenario(db) {
  seedMemoryFact(db, {
    id: 'fact_semantic_sqlite',
    projectId: 'proj1',
    subject: 'Project',
    predicate: 'uses',
    object: 'SQLite',
    detail: 'Fast local store',
    factType: 'semantic',
    heat: 0.9,
    scope: 'project',
  });
  seedMemoryFact(db, {
    id: 'fact_task_m1',
    projectId: 'proj1',
    subject: 'CLI',
    predicate: 'should',
    object: 'ship M1-1',
    factType: 'task',
    heat: 0.8,
    scope: 'project',
  });
  seedMemoryFact(db, {
    id: 'fact_global_preference',
    projectId: 'global-proj',
    subject: 'user',
    predicate: 'prefers',
    object: 'Bun',
    factType: 'preference',
    heat: 0.1,
    scope: 'global',
  });
}

const expectedBriefMarkdown = `# Project Memory Brief (3 facts)

[preference] user prefers Bun [global]
[semantic] Project uses SQLite \u2014 Fast local store
[task] CLI should ship M1-1`;

describe('getProjectBrief characterization', () => {
  let db;

  beforeEach(() => {
    db = createMemoryTestDb();
  });

  afterEach(() => {
    db?.close();
  });

  it('preserves the current markdown brief output', () => {
    seedBriefScenario(db);

    const result = getProjectBrief(db, 'proj1', { maxFacts: 3 });

    expect(result).toBe(expectedBriefMarkdown);
  });

  it('returns structured rows before markdown rendering', () => {
    seedBriefScenario(db);

    const rows = selectProjectBriefRows(db, 'proj1', { maxFacts: 3 });

    expect(rows).toEqual([
      expect.objectContaining({
        fact_id: 'fact_global_preference',
        project_id: 'global-proj',
        subject: 'user',
        predicate: 'prefers',
        object_text: 'Bun',
        object_detail: null,
        fact_type: 'preference',
        scope: 'global',
      }),
      expect.objectContaining({
        fact_id: 'fact_semantic_sqlite',
        project_id: 'proj1',
        subject: 'Project',
        predicate: 'uses',
        object_text: 'SQLite',
        object_detail: 'Fast local store',
        fact_type: 'semantic',
        scope: 'project',
      }),
      expect.objectContaining({
        fact_id: 'fact_task_m1',
        project_id: 'proj1',
        subject: 'CLI',
        predicate: 'should',
        object_text: 'ship M1-1',
        object_detail: null,
        fact_type: 'task',
        scope: 'project',
      }),
    ]);
    expect(renderProjectBriefRows(rows)).toBe(expectedBriefMarkdown);
  });

  it('preserves the current empty brief message', () => {
    const result = getProjectBrief(db, 'proj1', { maxFacts: 3 });

    expect(result).toBe('No project context available yet.');
  });
});
