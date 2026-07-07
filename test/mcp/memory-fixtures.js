import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const MIGRATION_FILES = [
  '001_init.sql',
  '003_scope.sql',
  '005_heat_decay.sql',
  '006_audit_log.sql',
  '007_v12_enhancements.sql',
];

export function createMemoryTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const stmts = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.toUpperCase().startsWith('PRAGMA'));
    for (const stmt of stmts) db.exec(stmt);
  }

  return db;
}

export function seedMemoryFact(db, {
  id,
  projectId = 'proj1',
  subject,
  predicate,
  object,
  detail = null,
  factType = 'semantic',
  confidence = 1,
  heat = 1,
  scope = 'project',
  status = 'active',
  createdAt = '2026-03-07T10:00:00Z',
  accessCount = 0,
}) {
  const entityId = `ent_${subject.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  const updatedAt = createdAt;

  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)')
    .run(projectId, projectId);
  db.prepare(`
    INSERT OR IGNORE INTO entities (
      id, canonical_name, entity_type, normalized_name, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(entityId, subject, 'concept', subject.toLowerCase(), createdAt, createdAt);
  db.prepare(`
    INSERT INTO facts (
      id, project_id, subject_entity_id, predicate, object_text, object_detail,
      fact_type, confidence, heat, decay_bucket, scope, status, base_heat,
      last_accessed_at, access_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    projectId,
    entityId,
    predicate,
    object,
    detail,
    factType,
    confidence,
    heat,
    'hot',
    scope,
    status,
    heat,
    createdAt,
    accessCount,
    createdAt,
    updatedAt
  );
}
