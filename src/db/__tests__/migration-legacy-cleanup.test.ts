import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getDatabase, initDatabase } from '../database';

function createLegacySchema(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version   INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE llm_providers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL,
      base_url      TEXT,
      default_model TEXT NOT NULL,
      is_enabled    INTEGER NOT NULL DEFAULT 1,
      extra_config  TEXT DEFAULT '{}',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE model_role_assignments (
      role          TEXT PRIMARY KEY CHECK (role IN ('legacy','planner','specialist','judge','embedding')),
      provider_id   TEXT NOT NULL REFERENCES llm_providers(id),
      model         TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE system_settings (
      key           TEXT PRIMARY KEY,
      value         TEXT NOT NULL,
      is_sensitive  INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.query('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
    1,
    'init_llm_provider_schema'
  );
  db.query(
    'INSERT INTO llm_providers (id, name, type, base_url, default_model, is_enabled, extra_config) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'provider-1',
    'LegacyProvider',
    'openai_compatible',
    'https://api.example.com/v1',
    'gpt-4o',
    1,
    '{}'
  );
  db.query('INSERT INTO model_role_assignments (role, provider_id, model) VALUES (?, ?, ?)').run(
    'legacy',
    'provider-1',
    'gpt-4o'
  );
  db.query('INSERT INTO model_role_assignments (role, provider_id, model) VALUES (?, ?, ?)').run(
    'planner',
    'provider-1',
    'gpt-4o-mini'
  );
  db.query('INSERT INTO system_settings (key, value, is_sensitive) VALUES (?, ?, ?)').run(
    'REVIEW_ENGINE',
    'legacy',
    0
  );
  db.close();
}

describe('migration 002 remove legacy review mode', () => {
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(() => {
    const tmpDir = join(tmpdir(), `db-migration-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, 'test.db');
    process.env.DATABASE_PATH = dbPath;
    createLegacySchema(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    if (savedDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    } catch {}
    try {
      if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    } catch {}
    try {
      if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
    } catch {}
  });

  test('normalizes REVIEW_ENGINE and drops legacy model-role rows', () => {
    initDatabase();
    const db = getDatabase();

    const engineRow = db
      .query('SELECT value FROM system_settings WHERE key = ?')
      .get('REVIEW_ENGINE') as { value: string } | null;
    expect(engineRow?.value).toBe('kernel');

    const roles = db
      .query('SELECT role FROM model_role_assignments ORDER BY role ASC')
      .all() as Array<{ role: string }>;
    expect(roles.map((row) => row.role)).toEqual(['planner']);

    expect(() => {
      db.query(
        'INSERT INTO model_role_assignments (role, provider_id, model) VALUES (?, ?, ?)'
      ).run('legacy', 'provider-1', 'gpt-4o');
    }).toThrow();
  });
});
