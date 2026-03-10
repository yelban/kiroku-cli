/**
 * Tests for v1.2 object_detail storage and retrieval.
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

describe('object_detail in storeFacts', () => {
  let db;

  beforeEach(async () => {
    db = createTestDb();
    const { setDb } = await import('../../src/worker/store.js');
    setDb(db);
  });

  it('should store detail from extraction', async () => {
    const { storeEntities, storeFacts } = await import('../../src/worker/store.js');
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('proj1', 'proj1');

    const entityMap = storeEntities([{ canonical_name: 'PostgreSQL', entity_type: 'topic' }], 'proj1');
    const factIds = storeFacts([{
      subject: 'PostgreSQL',
      predicate: 'is used as',
      object: 'database',
      detail: 'Chosen for jsonb support and RLS requirements',
      fact_type: 'semantic',
      confidence: 1.0,
    }], entityMap, 'proj1', null, { licensed: true });

    const fact = db.prepare('SELECT object_detail FROM facts WHERE id = ?').get(factIds[0]);
    expect(fact.object_detail).toBe('Chosen for jsonb support and RLS requirements');
  });

  it('should store null detail when not provided', async () => {
    const { storeEntities, storeFacts } = await import('../../src/worker/store.js');
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('proj1', 'proj1');

    const entityMap = storeEntities([{ canonical_name: 'Redis', entity_type: 'topic' }], 'proj1');
    const factIds = storeFacts([{
      subject: 'Redis',
      predicate: 'is used as',
      object: 'cache',
      fact_type: 'semantic',
      confidence: 1.0,
    }], entityMap, 'proj1', null, { licensed: true });

    const fact = db.prepare('SELECT object_detail FROM facts WHERE id = ?').get(factIds[0]);
    expect(fact.object_detail).toBeNull();
  });

  it('saveFactManually should store detail', async () => {
    const { saveFactManually } = await import('../../src/worker/store.js');
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('proj1', 'proj1');

    const fid = saveFactManually({
      subject: 'bun',
      predicate: 'preferred over',
      object: 'npm',
      detail: 'Much faster install times',
      factType: 'preference',
      projectId: 'proj1',
      scope: 'global',
    });

    const fact = db.prepare('SELECT object_detail FROM facts WHERE id = ?').get(fid);
    expect(fact.object_detail).toBe('Much faster install times');
  });
});
