import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getDatabase, initDatabase } from '../database';

function createInconsistentMigrationState(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE llm_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT,
      default_model TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      extra_config TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE llm_secrets (
      provider_id TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
      ciphertext BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE model_role_assignments (
      role TEXT PRIMARY KEY CHECK (role IN ('planner','specialist','judge','embedding')),
      provider_id TEXT NOT NULL REFERENCES llm_providers(id),
      model TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      is_sensitive INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.query('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
    1,
    'init_llm_provider_schema'
  );
  db.query('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
    2,
    'remove_legacy_review_mode'
  );
  db.query('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
    3,
    'add_repository_review_prompts'
  );

  db.close();
}

describe('migration self-heal for repository review prompts', () => {
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(() => {
    const tmpDir = join(tmpdir(), `db-migration-heal-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, 'test.db');
    process.env.DATABASE_PATH = dbPath;
    createInconsistentMigrationState(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    if (savedDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }

    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
  });

  test('rebuilds missing repository_review_prompts table even when migration 3 is marked applied', () => {
    initDatabase();
    const db = getDatabase();

    const tableRow = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('repository_review_prompts') as { name: string } | null;
    expect(tableRow?.name).toBe('repository_review_prompts');

    const migrationCountRow = db
      .query('SELECT COUNT(*) AS count FROM _migrations WHERE version = ?')
      .get(3) as { count: number } | null;
    expect(migrationCountRow?.count).toBe(1);
  });
});
