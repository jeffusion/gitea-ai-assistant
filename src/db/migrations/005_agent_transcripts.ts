import type { Database } from 'bun:sqlite';
import type { Migration } from '../database';

export const migration005AgentTranscripts: Migration = {
  version: 5,
  name: 'add_agent_transcripts',

  up(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id                   TEXT PRIMARY KEY,
        parent_session_id    TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
        parent_invocation_id TEXT,
        agent_type           TEXT NOT NULL,
        model                TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        metadata_json        TEXT NOT NULL DEFAULT '{}',
        final_result_json    TEXT,
        error_json           TEXT,
        started_at           TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at         TEXT,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_messages (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        sequence      INTEGER NOT NULL,
        role          TEXT NOT NULL,
        content_json  TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, sequence)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tool_calls (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        message_id     TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
        sequence       INTEGER NOT NULL,
        tool_name      TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        arguments_json TEXT NOT NULL DEFAULT '{}',
        result_json    TEXT,
        error_json     TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at   TEXT,
        UNIQUE(session_id, sequence)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_invocations (
        id                TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        child_session_id  TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
        sequence          INTEGER NOT NULL,
        agent_type        TEXT NOT NULL,
        model             TEXT NOT NULL,
        status            TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        input_json        TEXT NOT NULL DEFAULT '{}',
        result_json       TEXT,
        error_json        TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at      TEXT,
        UNIQUE(parent_session_id, sequence)
      )
    `);

    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_agent_sessions_parent ON agent_sessions(parent_session_id, created_at)'
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_agent_messages_session_sequence ON agent_messages(session_id, sequence)'
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_session_sequence ON agent_tool_calls(session_id, sequence)'
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_agent_invocations_parent_sequence ON agent_invocations(parent_session_id, sequence)'
    );
  },
};
