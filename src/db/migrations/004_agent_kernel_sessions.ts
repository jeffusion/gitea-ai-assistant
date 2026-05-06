import type { Database } from 'bun:sqlite';
import type { Migration } from '../database';

export const migration004AgentKernelSessions: Migration = {
  version: 4,
  name: 'agent_kernel_sessions',

  up(db: Database): void {
    db.exec(`
      CREATE TABLE agent_kernel_sessions (
        id            TEXT PRIMARY KEY,
        scope_type    TEXT NOT NULL CHECK (scope_type IN ('pull_request', 'commit')),
        scope_key     TEXT NOT NULL UNIQUE,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        last_run_id   TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.exec(`
      CREATE TABLE agent_kernel_session_events (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES agent_kernel_sessions(id) ON DELETE CASCADE,
        event_type    TEXT NOT NULL,
        payload_json  TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.exec(`
      CREATE TABLE agent_kernel_session_checkpoints (
        session_id         TEXT PRIMARY KEY REFERENCES agent_kernel_sessions(id) ON DELETE CASCADE,
        state_json         TEXT NOT NULL,
        pending_tasks_json TEXT NOT NULL,
        stop_reason        TEXT,
        state_version      INTEGER NOT NULL DEFAULT 1,
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.exec(
      'CREATE INDEX idx_agent_kernel_events_session ON agent_kernel_session_events(session_id, created_at)'
    );
  },
};
