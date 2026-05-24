import type { Database } from 'bun:sqlite';
import type { Migration } from '../database';

export const migration005AgentKernelSubagentInvocations: Migration = {
  version: 5,
  name: 'agent_kernel_subagent_invocations',

  up(db: Database): void {
    db.exec(`
      CREATE TABLE agent_kernel_subagent_invocations (
        id                TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL REFERENCES agent_kernel_sessions(id) ON DELETE CASCADE,
        parent_run_id     TEXT NOT NULL,
        parent_task_name  TEXT NOT NULL,
        subagent_name     TEXT NOT NULL,
        agent_id          TEXT NOT NULL,
        status            TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        input_json        TEXT NOT NULL,
        result_json       TEXT,
        started_at        TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at       TEXT
      )
    `);

    db.exec(
      'CREATE INDEX idx_agent_kernel_subagent_invocations_session ON agent_kernel_subagent_invocations(parent_session_id, started_at)'
    );
  },
};
