import { randomUUID } from 'node:crypto';
import { getDatabase } from '../../db/database';
import type {
  KernelCheckpoint,
  KernelDelegationPacket,
  KernelSessionEventRecord,
  KernelSessionRecord,
  KernelSubagentInvocationRecord,
  KernelSubagentInvocationResult,
} from '../types';

interface SessionRow {
  id: string;
  scope_type: 'pull_request' | 'commit';
  scope_key: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  last_run_id?: string;
}

interface EventRow {
  id: string;
  session_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

interface CheckpointRow {
  session_id: string;
  state_json: string;
  pending_tasks_json: string;
  stop_reason?: string;
  updated_at: string;
  state_version: number;
}

interface SubagentInvocationRow {
  id: string;
  parent_session_id: string;
  parent_run_id: string;
  parent_task_name: string;
  subagent_name: string;
  agent_id: string;
  status: 'running' | 'completed' | 'failed';
  input_json: string;
  result_json?: string;
  started_at: string;
  finished_at?: string;
}

function toSessionRecord(row: SessionRow): KernelSessionRecord {
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunId: row.last_run_id,
  };
}

export class KernelSessionRepository {
  ensureSession(input: {
    scopeType: 'pull_request' | 'commit';
    scopeKey: string;
    metadata: Record<string, unknown>;
    runId?: string;
  }): KernelSessionRecord {
    const db = getDatabase();
    const existing = db
      .query(
        `SELECT id, scope_type, scope_key, metadata_json, created_at, updated_at, last_run_id
         FROM agent_kernel_sessions
         WHERE scope_key = ?`
      )
      .get(input.scopeKey) as SessionRow | null;

    if (existing) {
      db.query(
        `UPDATE agent_kernel_sessions
         SET metadata_json = ?, updated_at = datetime('now'), last_run_id = ?
         WHERE id = ?`
      ).run(
        JSON.stringify(input.metadata),
        input.runId ?? existing.last_run_id ?? null,
        existing.id
      );

      return this.getSessionById(existing.id) as KernelSessionRecord;
    }

    const id = randomUUID();
    db.query(
      `INSERT INTO agent_kernel_sessions (
         id, scope_type, scope_key, metadata_json, last_run_id
       ) VALUES (?, ?, ?, ?, ?)`
    ).run(id, input.scopeType, input.scopeKey, JSON.stringify(input.metadata), input.runId ?? null);

    return this.getSessionById(id) as KernelSessionRecord;
  }

  getSessionById(sessionId: string): KernelSessionRecord | null {
    const db = getDatabase();
    const row = db
      .query(
        `SELECT id, scope_type, scope_key, metadata_json, created_at, updated_at, last_run_id
         FROM agent_kernel_sessions
         WHERE id = ?`
      )
      .get(sessionId) as SessionRow | null;

    return row ? toSessionRecord(row) : null;
  }

  getSessionByScopeKey(scopeKey: string): KernelSessionRecord | null {
    const db = getDatabase();
    const row = db
      .query(
        `SELECT id, scope_type, scope_key, metadata_json, created_at, updated_at, last_run_id
         FROM agent_kernel_sessions
         WHERE scope_key = ?`
      )
      .get(scopeKey) as SessionRow | null;

    return row ? toSessionRecord(row) : null;
  }

  listSessions(limit = 50): KernelSessionRecord[] {
    const db = getDatabase();
    const rows = db
      .query(
        `SELECT id, scope_type, scope_key, metadata_json, created_at, updated_at, last_run_id
         FROM agent_kernel_sessions
         ORDER BY updated_at DESC, created_at DESC
         LIMIT ?`
      )
      .all(limit) as SessionRow[];

    return rows.map(toSessionRecord);
  }

  appendEvent(
    sessionId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): KernelSessionEventRecord {
    const db = getDatabase();
    const id = randomUUID();
    db.query(
      `INSERT INTO agent_kernel_session_events (id, session_id, event_type, payload_json)
       VALUES (?, ?, ?, ?)`
    ).run(id, sessionId, eventType, JSON.stringify(payload));

    const row = db
      .query(
        `SELECT id, session_id, event_type, payload_json, created_at
         FROM agent_kernel_session_events
         WHERE id = ?`
      )
      .get(id) as EventRow;

    return {
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }

  listEvents(sessionId: string): KernelSessionEventRecord[] {
    const db = getDatabase();
    const rows = db
      .query(
        `SELECT id, session_id, event_type, payload_json, created_at
         FROM agent_kernel_session_events
         WHERE session_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(sessionId) as EventRow[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  saveCheckpoint<TState>(
    sessionId: string,
    checkpoint: KernelCheckpoint<TState>,
    stateVersion = 1
  ): void {
    const db = getDatabase();
    db.query(
      `INSERT INTO agent_kernel_session_checkpoints (
         session_id, state_json, pending_tasks_json, stop_reason, state_version, updated_at
       ) VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         state_json = excluded.state_json,
         pending_tasks_json = excluded.pending_tasks_json,
         stop_reason = excluded.stop_reason,
         state_version = excluded.state_version,
         updated_at = datetime('now')`
    ).run(
      sessionId,
      JSON.stringify(checkpoint.state),
      JSON.stringify(checkpoint.pendingTasks),
      checkpoint.stopReason ?? null,
      stateVersion
    );
  }

  loadCheckpoint<TState>(sessionId: string): KernelCheckpoint<TState> | null {
    const db = getDatabase();
    const row = db
      .query(
        `SELECT session_id, state_json, pending_tasks_json, stop_reason, updated_at, state_version
         FROM agent_kernel_session_checkpoints
         WHERE session_id = ?`
      )
      .get(sessionId) as CheckpointRow | null;

    if (!row) {
      return null;
    }

    return {
      state: JSON.parse(row.state_json) as TState,
      pendingTasks: JSON.parse(row.pending_tasks_json) as KernelCheckpoint<TState>['pendingTasks'],
      stopReason: row.stop_reason,
    };
  }

  deleteCheckpoint(sessionId: string): void {
    const db = getDatabase();
    db.query('DELETE FROM agent_kernel_session_checkpoints WHERE session_id = ?').run(sessionId);
  }

  createSubagentInvocation(input: {
    parentSessionId: string;
    parentRunId: string;
    parentTaskName: string;
    subagentName: string;
    agentId: string;
    packet: KernelDelegationPacket;
  }): KernelSubagentInvocationRecord {
    const db = getDatabase();
    const id = randomUUID();
    db.query(
      `INSERT INTO agent_kernel_subagent_invocations (
         id, parent_session_id, parent_run_id, parent_task_name, subagent_name, agent_id, status, input_json
       ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`
    ).run(
      id,
      input.parentSessionId,
      input.parentRunId,
      input.parentTaskName,
      input.subagentName,
      input.agentId,
      JSON.stringify(input.packet)
    );

    return this.getSubagentInvocationById(id) as KernelSubagentInvocationRecord;
  }

  completeSubagentInvocation(
    invocationId: string,
    status: 'completed' | 'failed',
    result: KernelSubagentInvocationResult
  ): KernelSubagentInvocationRecord {
    const db = getDatabase();
    db.query(
      `UPDATE agent_kernel_subagent_invocations
       SET status = ?, result_json = ?, finished_at = datetime('now')
       WHERE id = ?`
    ).run(status, JSON.stringify(result), invocationId);

    return this.getSubagentInvocationById(invocationId) as KernelSubagentInvocationRecord;
  }

  listSubagentInvocations(parentSessionId: string): KernelSubagentInvocationRecord[] {
    const db = getDatabase();
    const rows = db
      .query(
        `SELECT id, parent_session_id, parent_run_id, parent_task_name, subagent_name, agent_id,
                status, input_json, result_json, started_at, finished_at
         FROM agent_kernel_subagent_invocations
         WHERE parent_session_id = ?
         ORDER BY started_at ASC, id ASC`
      )
      .all(parentSessionId) as SubagentInvocationRow[];

    return rows.map((row) => this.toSubagentInvocationRecord(row));
  }

  private getSubagentInvocationById(invocationId: string): KernelSubagentInvocationRecord | null {
    const db = getDatabase();
    const row = db
      .query(
        `SELECT id, parent_session_id, parent_run_id, parent_task_name, subagent_name, agent_id,
                status, input_json, result_json, started_at, finished_at
         FROM agent_kernel_subagent_invocations
         WHERE id = ?`
      )
      .get(invocationId) as SubagentInvocationRow | null;

    return row ? this.toSubagentInvocationRecord(row) : null;
  }

  private toSubagentInvocationRecord(row: SubagentInvocationRow): KernelSubagentInvocationRecord {
    return {
      id: row.id,
      parentSessionId: row.parent_session_id,
      parentRunId: row.parent_run_id,
      parentTaskName: row.parent_task_name,
      subagentName: row.subagent_name,
      agentId: row.agent_id,
      status: row.status,
      input: JSON.parse(row.input_json) as KernelDelegationPacket,
      result: row.result_json
        ? (JSON.parse(row.result_json) as KernelSubagentInvocationResult)
        : undefined,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }
}

export const kernelSessionRepository = new KernelSessionRepository();
