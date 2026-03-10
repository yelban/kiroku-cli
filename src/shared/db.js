import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DB_PATH, KIROKU_ROOT, ensureDirs } from './paths.js';
import { SQLITE_PRAGMAS } from './constants.js';
import { createLogger } from './logger.js';
const log = createLogger('db');
let _db = null;
let _vecEnabled = false;

export function getDb() {
  if (!_db) throw new Error('DB not initialized. Call initDb() first.');
  return _db;
}

export async function initDb() {
  if (_db) return _db;
  ensureDirs();
  _db = new Database(DB_PATH);

  for (const pragma of SQLITE_PRAGMAS) {
    _db.pragma(pragma.replace('PRAGMA ', ''));
  }

  try {
    const sqliteVec = await import('sqlite-vec');
    sqliteVec.load(_db);
    _vecEnabled = true;
    log.info('sqlite-vec extension loaded');
  } catch (err) {
    log.warn({ err: err.message }, 'sqlite-vec not available, vector search disabled');
    _vecEnabled = false;
  }

  return _db;
}

export function isVecEnabled() {
  return _vecEnabled;
}

export function runMigrations() {
  const db = _db;
  if (!db) throw new Error('DB not initialized');

  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const migrationsDir = join(KIROKU_ROOT, 'migrations');
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  );

  for (const file of files) {
    if (applied.has(file)) continue;

    // Skip vec migration if vec not available
    if (file.includes('vec') && !_vecEnabled) {
      log.warn(`Skipping ${file} (sqlite-vec not available)`);
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    log.info(`Running migration: ${file}`);

    // Split by semicolons and run each statement (skip PRAGMA in migrations, already set)
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      if (stmt.toUpperCase().startsWith('PRAGMA')) continue; // already applied
      db.exec(stmt);
    }

    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  }

  log.info('Migrations complete');
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
    _vecEnabled = false;
  }
}
