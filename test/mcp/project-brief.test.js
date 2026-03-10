/**
 * Tests for v1.2 project-brief dynamic resource.
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
  const files = ['001_init.sql', '003_scope.sql', '005_heat_decay.sql', '006_audit_log.sql', '007_v12_enhancements.sql'];
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
  const id = `fact_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`INSERT INTO facts (id, project_id, subject_entity_id, predicate, object_text, object_detail, fact_type, confidence, heat, decay_bucket, scope, status, base_heat, last_accessed_at, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, projectId, entId, predicate, object, detail || null, factType, 1.0, heat, 'hot', scope || 'project', 'active', heat, new Date().toISOString(), 0);
}

describe('getProjectBrief', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should return empty message for DB with no facts', async () => {
    const { getProjectBrief } = await import('../../src/mcp/project-brief.js');
    const result = getProjectBrief(db, 'proj1', 50);
    expect(result).toBe('No project context available yet.');
  });

  it('should order by type priority (preference > semantic > task > state > episodic)', async () => {
    const { getProjectBrief } = await import('../../src/mcp/project-brief.js');
    seedFact(db, { projectId: 'proj1', subject: 'E1', predicate: 'is', object: 'episodic', factType: 'episodic', heat: 1.0 });
    seedFact(db, { projectId: 'proj1', subject: 'P1', predicate: 'prefers', object: 'bun', factType: 'preference', heat: 1.0, scope: 'global' });
    seedFact(db, { projectId: 'proj1', subject: 'S1', predicate: 'uses', object: 'TypeScript', factType: 'semantic', heat: 1.0 });

    const result = getProjectBrief(db, 'proj1', 50);
    const lines = result.split('\n').filter(l => l.startsWith('['));

    expect(lines[0]).toContain('[preference]');
    expect(lines[1]).toContain('[semantic]');
    expect(lines[2]).toContain('[episodic]');
  });

  it('should sort by heat within same type', async () => {
    const { getProjectBrief } = await import('../../src/mcp/project-brief.js');
    seedFact(db, { projectId: 'proj1', subject: 'Low', predicate: 'is', object: 'low', factType: 'semantic', heat: 0.3 });
    seedFact(db, { projectId: 'proj1', subject: 'High', predicate: 'is', object: 'high', factType: 'semantic', heat: 0.9 });

    const result = getProjectBrief(db, 'proj1', 50);
    const lines = result.split('\n').filter(l => l.startsWith('['));

    expect(lines[0]).toContain('High');
    expect(lines[1]).toContain('Low');
  });

  it('should respect maxFacts limit', async () => {
    const { getProjectBrief } = await import('../../src/mcp/project-brief.js');
    for (let i = 0; i < 10; i++) {
      seedFact(db, { projectId: 'proj1', subject: `S${i}`, predicate: 'is', object: `val${i}`, factType: 'semantic', heat: 0.5 });
    }

    const result = getProjectBrief(db, 'proj1', 3);
    const lines = result.split('\n').filter(l => l.startsWith('['));
    expect(lines).toHaveLength(3);
    expect(result).toContain('3 facts');
  });

  it('should include object_detail when present', async () => {
    const { getProjectBrief } = await import('../../src/mcp/project-brief.js');
    seedFact(db, { projectId: 'proj1', subject: 'DB', predicate: 'uses', object: 'PostgreSQL', factType: 'semantic', heat: 0.8, detail: 'Chosen for jsonb support' });

    const result = getProjectBrief(db, 'proj1', 50);
    expect(result).toContain('Chosen for jsonb support');
    expect(result).toContain('—');
  });

  it('should include global facts with [global] marker', async () => {
    const { getProjectBrief } = await import('../../src/mcp/project-brief.js');
    seedFact(db, { projectId: 'proj1', subject: 'user', predicate: 'prefers', object: 'bun', factType: 'preference', heat: 1.0, scope: 'global' });

    const result = getProjectBrief(db, 'proj1', 50);
    expect(result).toContain('[global]');
  });
});
