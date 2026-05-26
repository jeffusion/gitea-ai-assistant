/**
 * SQLite database initialization and migration runner.
 *
 * Uses bun:sqlite (zero-dependency, built into Bun runtime).
 * Single file at DATA_DIR/assistant.db with WAL mode for concurrent reads.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { migration001Init } from './migrations/001_init';
import { migration002RemoveLegacyReviewMode } from './migrations/002_remove_legacy_review_mode';
import { migration003RepositoryReviewPrompts } from './migrations/003_repository_review_prompts';
import { migration004RemoveEmbeddingRole } from './migrations/004_remove_embedding_role';
import { migration005AgentTranscripts } from './migrations/005_agent_transcripts';
import { migration006DropLegacyAssignments } from './migrations/006_drop_legacy_assignments';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Migration {
  version: number;
  name: string;
  up(db: Database): void;
}

// ---------------------------------------------------------------------------
// Migration registry (ordered by version)
// ---------------------------------------------------------------------------

const MIGRATIONS: Migration[] = [
  migration001Init,
  migration002RemoveLegacyReviewMode,
  migration003RepositoryReviewPrompts,
  migration004RemoveEmbeddingRole,
  migration005AgentTranscripts,
  migration006DropLegacyAssignments,
];

const REPOSITORY_REVIEW_PROMPTS_TABLE = 'repository_review_prompts';

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

let db: Database | null = null;

/**
 * Resolve the database file path.
 * Defaults to `data/assistant.db` relative to CWD, overridable via `DATABASE_PATH` env.
 */
function getDbPath(): string {
  return resolve(process.env.DATABASE_PATH || './data/assistant.db');
}

/**
 * Initialize the SQLite database.
 * Creates the file and parent directories if needed.
 * Enables WAL mode and runs pending migrations.
 *
 * MUST be called once at application startup.
 */
export function initDatabase(): Database {
  if (db) return db;

  const dbPath = getDbPath();
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.exec('PRAGMA journal_mode = WAL');
  // Enable foreign keys
  db.exec('PRAGMA foreign_keys = ON');
  // Reasonable busy timeout for concurrent writes
  db.exec('PRAGMA busy_timeout = 5000');

  // Run migrations
  runMigrations(db);
  ensureRepositoryReviewPromptsSchema(db);

  console.log(`📦 Database initialized at ${dbPath}`);
  return db;
}

function doesTableExist(database: Database, tableName: string): boolean {
  const row = database
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | null;
  return row?.name === tableName;
}

export function ensureRepositoryReviewPromptsSchema(database: Database = getDatabase()): void {
  if (doesTableExist(database, REPOSITORY_REVIEW_PROMPTS_TABLE)) {
    return;
  }

  console.warn(
    `⚠️ Detected inconsistent DB state: table '${REPOSITORY_REVIEW_PROMPTS_TABLE}' is missing. Rebuilding schema.`
  );

  database.transaction(() => {
    migration003RepositoryReviewPrompts.up(database);

    if (doesTableExist(database, '_migrations')) {
      database
        .query('INSERT OR IGNORE INTO _migrations (version, name) VALUES (?, ?)')
        .run(migration003RepositoryReviewPrompts.version, migration003RepositoryReviewPrompts.name);
    }
  })();
}

/**
 * Get the database instance. Throws if not initialized.
 */
export function getDatabase(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() at startup.');
  }
  return db;
}

/**
 * Close the database connection gracefully.
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Create the migrations tracking table if it doesn't exist,
 * then run any migrations that haven't been applied yet.
 */
function runMigrations(database: Database): void {
  // Create migration tracking table
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version   INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Get already-applied versions
  const applied = new Set<number>(
    database
      .query('SELECT version FROM _migrations ORDER BY version')
      .all()
      .map((row: any) => row.version as number)
  );

  // Run pending migrations in order
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    console.log(`  ⬆️  Running migration ${migration.version}: ${migration.name}`);

    database.transaction(() => {
      migration.up(database);
      database
        .query('INSERT INTO _migrations (version, name) VALUES (?, ?)')
        .run(migration.version, migration.name);
    })();
  }
}
