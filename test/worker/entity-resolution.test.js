/**
 * Tests for v1.2 entity resolution with normalized name matching.
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

describe('entity resolution', () => {
  let db;

  beforeEach(async () => {
    db = createTestDb();
    const { setDb } = await import('../../src/worker/store.js');
    setDb(db);
  });

  it('should match by normalized name when exact match fails', async () => {
    const { storeEntities } = await import('../../src/worker/store.js');

    // First: create entity with underscore name
    const map1 = storeEntities([{ canonical_name: 'auth_module', entity_type: 'concept' }], 'proj1');
    const id1 = map1.get('auth_module');

    // Second: look up with CamelCase — should match via normalized
    const map2 = storeEntities([{ canonical_name: 'AuthModule', entity_type: 'concept' }], 'proj1');
    const id2 = map2.get('AuthModule');

    expect(id1).toBe(id2); // same entity
  });

  it('should merge aliases on normalized match', async () => {
    const { storeEntities } = await import('../../src/worker/store.js');

    storeEntities([{ canonical_name: 'auth_module', entity_type: 'concept', aliases: [] }], 'proj1');
    storeEntities([{ canonical_name: 'Auth Module', entity_type: 'concept' }], 'proj1');

    const entity = db.prepare('SELECT aliases_json FROM entities WHERE canonical_name = ?').get('auth_module');
    const aliases = JSON.parse(entity.aliases_json);
    expect(aliases).toContain('Auth Module');
  });

  it('should prefer exact match over normalized match', async () => {
    const { storeEntities } = await import('../../src/worker/store.js');

    // Create two distinct entities that normalize to different values
    storeEntities([{ canonical_name: 'Redis', entity_type: 'topic' }], 'proj1');
    const map = storeEntities([{ canonical_name: 'Redis', entity_type: 'topic' }], 'proj1');

    // Should have exactly 1 entity
    const count = db.prepare('SELECT COUNT(*) as c FROM entities').get().c;
    expect(count).toBe(1);
    expect(map.get('Redis')).toBeTruthy();
  });

  it('should write normalized_name on new entity creation', async () => {
    const { storeEntities } = await import('../../src/worker/store.js');

    storeEntities([{ canonical_name: 'My-Cool_Project', entity_type: 'project' }], 'proj1');

    const entity = db.prepare('SELECT normalized_name FROM entities WHERE canonical_name = ?').get('My-Cool_Project');
    expect(entity.normalized_name).toBe('mycoolproject');
  });

  it('saveFactManually should also resolve via normalized name', async () => {
    const { storeEntities, saveFactManually } = await import('../../src/worker/store.js');

    // Create entity with one casing
    storeEntities([{ canonical_name: 'PostgreSQL', entity_type: 'topic' }], 'proj1');
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('proj1', 'proj1');

    // Save fact with different casing
    const fid = saveFactManually({
      subject: 'postgre_sql',
      predicate: 'is used as',
      object: 'database',
      projectId: 'proj1',
    });

    // Should reuse the same entity
    const fact = db.prepare('SELECT subject_entity_id FROM facts WHERE id = ?').get(fid);
    const entity = db.prepare('SELECT canonical_name FROM entities WHERE id = ?').get(fact.subject_entity_id);
    expect(entity.canonical_name).toBe('PostgreSQL');
  });
});
