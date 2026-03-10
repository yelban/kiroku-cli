/**
 * Tests for v1.2 per-type decay, project freeze, and floor.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

function seedProject(db, id, lastActiveAt) {
  db.prepare('INSERT INTO projects (id, name, last_active_at) VALUES (?, ?, ?)').run(id, id, lastActiveAt);
}

function seedFact(db, { id, projectId, factType, baseHeat, lastAccessedAt }) {
  db.prepare('INSERT INTO entities (id, canonical_name, entity_type, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(`ent_${id}`, `entity_${id}`, 'concept', new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO facts (id, project_id, subject_entity_id, predicate, object_text, fact_type, confidence, heat, decay_bucket, scope, status, base_heat, last_accessed_at, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, projectId, `ent_${id}`, 'test', 'test', factType, 1.0, baseHeat, 'hot', 'project', 'active', baseHeat, lastAccessedAt, 0);
}

describe('runDecaySweep v1.2', () => {
  let db;

  beforeEach(async () => {
    db = createTestDb();
    const { setDb } = await import('../../src/worker/store.js');
    setDb(db);
  });

  const baseConfig = {
    worker: {
      decay: {
        enabled: true,
        halfLifeHours: 168,
        halfLifeByType: {
          state: 168,
          episodic: 336,
          task: 504,
          semantic: 1440,
          preference: null,
        },
        floorByType: {
          state: 0.05,
          episodic: 0.1,
          task: 0.15,
          semantic: 0.3,
          preference: 0.7,
        },
        freezeAfterInactiveDays: 7,
      },
    },
  };

  it('should apply per-type half-life (semantic decays slower than state)', async () => {
    const { runDecaySweep } = await import('../../src/worker/store.js');
    const past = new Date(Date.now() - 168 * 3600000).toISOString(); // 7 days ago
    seedProject(db, 'proj1', new Date().toISOString());
    seedFact(db, { id: 'f_state', projectId: 'proj1', factType: 'state', baseHeat: 1.0, lastAccessedAt: past });
    seedFact(db, { id: 'f_semantic', projectId: 'proj1', factType: 'semantic', baseHeat: 1.0, lastAccessedAt: past });

    runDecaySweep(baseConfig);

    const stateHeat = db.prepare('SELECT heat FROM facts WHERE id = ?').get('f_state').heat;
    const semanticHeat = db.prepare('SELECT heat FROM facts WHERE id = ?').get('f_semantic').heat;
    // state: 1.0 * 0.5^(168/168) = 0.5; semantic: 1.0 * 0.5^(168/1440) ≈ 0.92
    expect(stateHeat).toBeCloseTo(0.5, 1);
    expect(semanticHeat).toBeGreaterThan(0.8);
    expect(semanticHeat).toBeGreaterThan(stateHeat);
  });

  it('should never decay preference type (halfLife=null)', async () => {
    const { runDecaySweep } = await import('../../src/worker/store.js');
    const past = new Date(Date.now() - 720 * 3600000).toISOString(); // 30 days ago
    seedProject(db, 'proj1', new Date().toISOString());
    seedFact(db, { id: 'f_pref', projectId: 'proj1', factType: 'preference', baseHeat: 1.0, lastAccessedAt: past });

    runDecaySweep(baseConfig);

    const heat = db.prepare('SELECT heat FROM facts WHERE id = ?').get('f_pref').heat;
    expect(heat).toBe(1.0); // unchanged
  });

  it('should apply floor (heat never drops below floor)', async () => {
    const { runDecaySweep } = await import('../../src/worker/store.js');
    const veryOld = new Date(Date.now() - 8760 * 3600000).toISOString(); // 1 year ago
    seedProject(db, 'proj1', new Date().toISOString());
    seedFact(db, { id: 'f_sem', projectId: 'proj1', factType: 'semantic', baseHeat: 1.0, lastAccessedAt: veryOld });

    runDecaySweep(baseConfig);

    const heat = db.prepare('SELECT heat FROM facts WHERE id = ?').get('f_sem').heat;
    expect(heat).toBeCloseTo(0.3, 1); // floor for semantic
  });

  it('should skip facts in frozen projects', async () => {
    const { runDecaySweep } = await import('../../src/worker/store.js');
    const past = new Date(Date.now() - 168 * 3600000).toISOString();
    const oldDate = new Date(Date.now() - 30 * 24 * 3600000).toISOString(); // 30 days ago
    seedProject(db, 'frozen_proj', oldDate);
    seedFact(db, { id: 'f_frozen', projectId: 'frozen_proj', factType: 'state', baseHeat: 0.8, lastAccessedAt: past });

    runDecaySweep(baseConfig);

    const heat = db.prepare('SELECT heat FROM facts WHERE id = ?').get('f_frozen').heat;
    expect(heat).toBe(0.8); // unchanged — project is frozen
  });

  it('should use default halfLifeHours for unknown fact_type', async () => {
    const { runDecaySweep } = await import('../../src/worker/store.js');
    const past = new Date(Date.now() - 168 * 3600000).toISOString();
    seedProject(db, 'proj1', new Date().toISOString());
    seedFact(db, { id: 'f_custom', projectId: 'proj1', factType: 'custom_type', baseHeat: 1.0, lastAccessedAt: past });

    runDecaySweep(baseConfig);

    const heat = db.prepare('SELECT heat FROM facts WHERE id = ?').get('f_custom').heat;
    // default 168h half-life, 168h elapsed → 0.5
    expect(heat).toBeCloseTo(0.5, 1);
  });

  it('should correctly assign decay buckets', async () => {
    const { runDecaySweep } = await import('../../src/worker/store.js');
    seedProject(db, 'proj1', new Date().toISOString());
    // hot: base 1.0, just accessed
    seedFact(db, { id: 'f_hot', projectId: 'proj1', factType: 'state', baseHeat: 1.0, lastAccessedAt: new Date().toISOString() });
    // warm: base 0.5, some decay
    const warmPast = new Date(Date.now() - 100 * 3600000).toISOString();
    seedFact(db, { id: 'f_warm', projectId: 'proj1', factType: 'state', baseHeat: 0.5, lastAccessedAt: warmPast });
    // cold: base 0.3, heavily decayed
    const coldPast = new Date(Date.now() - 500 * 3600000).toISOString();
    seedFact(db, { id: 'f_cold', projectId: 'proj1', factType: 'state', baseHeat: 0.3, lastAccessedAt: coldPast });

    runDecaySweep(baseConfig);

    expect(db.prepare('SELECT decay_bucket FROM facts WHERE id = ?').get('f_hot').decay_bucket).toBe('hot');
    expect(db.prepare('SELECT decay_bucket FROM facts WHERE id = ?').get('f_cold').decay_bucket).toBe('cold');
  });

  it('should not run when decay is disabled', async () => {
    const { runDecaySweep } = await import('../../src/worker/store.js');
    const past = new Date(Date.now() - 168 * 3600000).toISOString();
    seedProject(db, 'proj1', new Date().toISOString());
    seedFact(db, { id: 'f1', projectId: 'proj1', factType: 'state', baseHeat: 1.0, lastAccessedAt: past });

    runDecaySweep({ worker: { decay: { enabled: false } } });

    const heat = db.prepare('SELECT heat FROM facts WHERE id = ?').get('f1').heat;
    expect(heat).toBe(1.0); // unchanged
  });

  it('should handle freezeAfterInactiveDays = 0 (no freezing)', async () => {
    const { runDecaySweep } = await import('../../src/worker/store.js');
    const past = new Date(Date.now() - 168 * 3600000).toISOString();
    const oldDate = new Date(Date.now() - 30 * 24 * 3600000).toISOString();
    seedProject(db, 'old_proj', oldDate);
    seedFact(db, { id: 'f_old', projectId: 'old_proj', factType: 'state', baseHeat: 1.0, lastAccessedAt: past });

    const noFreezeConfig = { ...baseConfig, worker: { ...baseConfig.worker, decay: { ...baseConfig.worker.decay, freezeAfterInactiveDays: 0 } } };
    runDecaySweep(noFreezeConfig);

    const heat = db.prepare('SELECT heat FROM facts WHERE id = ?').get('f_old').heat;
    expect(heat).toBeLessThan(1.0); // should decay, not frozen
  });
});
