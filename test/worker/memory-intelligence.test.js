/**
 * Tests for Memory Intelligence: embedding alignment, diversity filter, token budget, compaction sweep.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const files = ['001_init.sql', '003_scope.sql', '005_heat_decay.sql', '006_audit_log.sql', '007_v12_enhancements.sql', '008_content_dedup_index.sql'];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const stmts = sql.split(';').map(s => s.trim()).filter(s => s && !s.toUpperCase().startsWith('PRAGMA'));
    for (const stmt of stmts) db.exec(stmt);
  }
  return db;
}

function seedEntity(db, name) {
  const id = `ent_${name}`;
  db.prepare('INSERT OR IGNORE INTO entities (id, canonical_name, entity_type, normalized_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, 'concept', name.toLowerCase(), new Date().toISOString(), new Date().toISOString());
  return id;
}

function seedFact(db, { projectId, subject, predicate, object, factType, heat, scope, detail }) {
  const entId = seedEntity(db, subject);
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(projectId, projectId);
  const id = `fact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO facts (id, project_id, subject_entity_id, predicate, object_text, object_detail, fact_type, confidence, heat, decay_bucket, scope, status, base_heat, last_accessed_at, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, projectId, entId, predicate, object, detail || null, factType, 1.0, heat, 'hot', scope || 'project', 'active', heat, new Date().toISOString(), 0);
  return id;
}

// ─── Phase 0: Embedding Alignment ───

describe('storeFacts aligned return', () => {
  let db;

  beforeEach(async () => {
    db = createTestDb();
    const { setDb } = await import('../../src/worker/store.js');
    setDb(db);
  });

  it('should return null for deduped facts, keeping array aligned', async () => {
    const { storeFacts, storeEntities } = await import('../../src/worker/store.js');
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run('proj1', 'proj1');

    const entities = [{ canonical_name: 'Python', entity_type: 'concept' }];
    const entityMap = storeEntities(entities, 'proj1');

    const facts = [
      { subject: 'Python', predicate: 'is used as', object: 'primary language', fact_type: 'semantic' },
      { subject: 'Python', predicate: 'is preferred over', object: 'JavaScript', fact_type: 'semantic' },
      { subject: 'Python', predicate: 'is used as', object: 'primary language', fact_type: 'semantic' }, // duplicate of [0]
    ];

    const results = storeFacts(facts, entityMap, 'proj1', null, null);
    expect(results).toHaveLength(3);
    expect(results[0]).toBeTruthy(); // inserted
    expect(results[1]).toBeTruthy(); // inserted (different predicate+object)
    expect(results[2]).toBeNull();   // deduped
  });

  it('should return all non-null when no duplicates exist', async () => {
    const { storeFacts, storeEntities } = await import('../../src/worker/store.js');
    db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run('proj1', 'proj1');

    const entities = [{ canonical_name: 'A', entity_type: 'concept' }];
    const entityMap = storeEntities(entities, 'proj1');

    const facts = [
      { subject: 'A', predicate: 'is', object: 'one', fact_type: 'semantic' },
      { subject: 'A', predicate: 'is', object: 'two', fact_type: 'semantic' },
    ];

    const results = storeFacts(facts, entityMap, 'proj1', null, null);
    expect(results).toHaveLength(2);
    expect(results.every(r => r !== null)).toBe(true);
  });
});

// ─── Phase 1: Diversity Filter ───

describe('diversity filter', () => {
  it('should filter out same-subject near-duplicate facts in project brief', async () => {
    const db = createTestDb();
    const { getProjectBrief } = await import('../../src/mcp/project-brief.js');

    // 3 facts with same subject, similar predicate/object words
    seedFact(db, { projectId: 'proj1', subject: 'Python', predicate: 'is used as', object: 'primary language for backend', factType: 'semantic', heat: 0.9 });
    seedFact(db, { projectId: 'proj1', subject: 'Python', predicate: 'is used as', object: 'primary language for development', factType: 'semantic', heat: 0.8 });
    seedFact(db, { projectId: 'proj1', subject: 'Python', predicate: 'is preferred over', object: 'Ruby', factType: 'semantic', heat: 0.7 });

    const result = getProjectBrief(db, 'proj1', { maxFacts: 50, maxTokens: 0 });
    const lines = result.split('\n').filter(l => l.startsWith('['));

    // First and third should remain, second filtered as near-duplicate of first
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('backend');
    expect(lines[1]).toContain('Ruby');
  });

  it('should not filter facts with different subjects', async () => {
    const db = createTestDb();
    const { getProjectBrief } = await import('../../src/mcp/project-brief.js');

    seedFact(db, { projectId: 'proj1', subject: 'Python', predicate: 'is used as', object: 'primary language', factType: 'semantic', heat: 0.9 });
    seedFact(db, { projectId: 'proj1', subject: 'JavaScript', predicate: 'is used as', object: 'primary language', factType: 'semantic', heat: 0.8 });

    const result = getProjectBrief(db, 'proj1', { maxFacts: 50, maxTokens: 0 });
    const lines = result.split('\n').filter(l => l.startsWith('['));

    expect(lines).toHaveLength(2);
  });

  it('should respect maxTokens budget', async () => {
    const db = createTestDb();
    const { getProjectBrief } = await import('../../src/mcp/project-brief.js');

    for (let i = 0; i < 20; i++) {
      seedFact(db, { projectId: 'proj1', subject: `Entity${i}`, predicate: 'has property', object: `value number ${i} with some extra text`, factType: 'semantic', heat: 0.9 - i * 0.01 });
    }

    // With a tight token budget, should truncate early
    const result = getProjectBrief(db, 'proj1', { maxFacts: 50, maxTokens: 100 });
    const lines = result.split('\n').filter(l => l.startsWith('['));

    expect(lines.length).toBeLessThan(20);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('should still accept old number signature for backward compatibility', async () => {
    const db = createTestDb();
    const { getProjectBrief } = await import('../../src/mcp/project-brief.js');

    seedFact(db, { projectId: 'proj1', subject: 'A', predicate: 'is', object: 'b', factType: 'semantic', heat: 0.9 });

    const result = getProjectBrief(db, 'proj1', 50);
    expect(result).toContain('[semantic]');
  });
});

// ─── Phase 1: Jaccard utility ───

describe('jaccardSimilarity', () => {
  it('should return 1 for identical sets', async () => {
    const { tokenize, jaccardSimilarity } = await import('../../src/mcp/project-brief.js');
    const a = tokenize('hello world');
    expect(jaccardSimilarity(a, a)).toBe(1);
  });

  it('should return 0 for disjoint sets', async () => {
    const { tokenize, jaccardSimilarity } = await import('../../src/mcp/project-brief.js');
    const a = tokenize('hello world');
    const b = tokenize('foo bar');
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('should return correct value for partial overlap', async () => {
    const { tokenize, jaccardSimilarity } = await import('../../src/mcp/project-brief.js');
    const a = tokenize('primary language backend');
    const b = tokenize('primary language development');
    // intersection: {primary, language} = 2, union: {primary, language, backend, development} = 4
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5, 2);
  });
});

// ─── Phase 2: Compaction Sweep (no vec, should skip) ───

describe('runCompactionSweep', () => {
  it('should return {merged:0, conflicts:0} when vec is not enabled', async () => {
    const db = createTestDb();
    // vec is not enabled in test (no sqlite-vec loaded)
    const { runCompactionSweep } = await import('../../src/worker/store.js');
    const result = runCompactionSweep(db);
    expect(result).toEqual({ merged: 0, conflicts: 0 });
  });
});

// ─── Phase 1: estimateTokens ───

describe('estimateTokens', () => {
  it('should estimate ASCII text', async () => {
    const { estimateTokens } = await import('../../src/mcp/project-brief.js');
    const result = estimateTokens('hello world this is a test');
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(20);
  });

  it('should count CJK characters at higher rate', async () => {
    const { estimateTokens } = await import('../../src/mcp/project-brief.js');
    const ascii = estimateTokens('hello world');
    const cjk = estimateTokens('你好世界測試');
    // CJK should have higher token estimate per character
    expect(cjk / 6).toBeGreaterThan(ascii / 11);
  });
});
