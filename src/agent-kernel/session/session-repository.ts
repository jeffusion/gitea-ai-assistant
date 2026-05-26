import { randomUUID } from 'node:crypto';
import { getDatabase } from '../../db/database';
import { redactSensitiveFields } from './redaction';
import type {
  AgentInvocationRecord,
  AgentInvocationTranscript,
  AgentMessageRecord,
  AgentSessionRecord,
  AgentSessionStatus,
  AgentSessionTree,
  AgentToolCallRecord,
  AgentToolCallStatus,
  AppendAgentMessageInput,
  AppendAgentToolCallInput,
  CompleteAgentInvocationInput,
  CompleteAgentSessionInput,
  CreateAgentInvocationInput,
  CreateAgentSessionInput,
} from './types';

interface AgentSessionRow {
  id: string;
  parent_session_id: string | null;
  parent_invocation_id: string | null;
  agent_type: string;
  model: string;
  status: AgentSessionStatus;
  metadata_json: string;
  final_result_json: string | null;
  error_json: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentMessageRow {
  id: string;
  session_id: string;
  sequence: number;
  role: string;
  content_json: string;
  metadata_json: string;
  created_at: string;
}

interface AgentToolCallRow {
  id: string;
  session_id: string;
  message_id: string | null;
  sequence: number;
  tool_name: string;
  status: AgentToolCallStatus;
  arguments_json: string;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  completed_at: string | null;
}

interface AgentInvocationRow {
  id: string;
  parent_session_id: string;
  child_session_id: string | null;
  sequence: number;
  agent_type: string;
  model: string;
  status: AgentSessionStatus;
  input_json: string;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  completed_at: string | null;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(redactSensitiveFields(value));
}

function parseJson(value: string | null): unknown | undefined {
  return value === null ? undefined : JSON.parse(value);
}

function nextSequence(tableName: string, ownerColumn: string, ownerId: string): number {
  const db = getDatabase();
  const row = db
    .query(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM ${tableName} WHERE ${ownerColumn} = ?`
    )
    .get(ownerId) as { next_sequence: number };
  return row.next_sequence;
}

function toSessionRecord(row: AgentSessionRow): AgentSessionRecord {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id ?? undefined,
    parentInvocationId: row.parent_invocation_id ?? undefined,
    agentType: row.agent_type,
    model: row.model,
    status: row.status,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    finalResult: parseJson(row.final_result_json),
    error: parseJson(row.error_json),
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessageRecord(row: AgentMessageRow): AgentMessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    role: row.role,
    content: JSON.parse(row.content_json),
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function toToolCallRecord(row: AgentToolCallRow): AgentToolCallRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id ?? undefined,
    sequence: row.sequence,
    toolName: row.tool_name,
    status: row.status,
    arguments: JSON.parse(row.arguments_json),
    result: parseJson(row.result_json),
    error: parseJson(row.error_json),
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function toInvocationRecord(row: AgentInvocationRow): AgentInvocationRecord {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    childSessionId: row.child_session_id ?? undefined,
    sequence: row.sequence,
    agentType: row.agent_type,
    model: row.model,
    status: row.status,
    input: JSON.parse(row.input_json),
    result: parseJson(row.result_json),
    error: parseJson(row.error_json),
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export class AgentSessionRepository {
  createSession(input: CreateAgentSessionInput): AgentSessionRecord {
    const db = getDatabase();
    const id = input.id ?? randomUUID();
    db.query(
      `INSERT INTO agent_sessions (
         id, parent_session_id, parent_invocation_id, agent_type, model, status, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.parentSessionId ?? null,
      input.parentInvocationId ?? null,
      input.agentType,
      input.model,
      input.status ?? 'running',
      stringifyJson(input.metadata ?? {})
    );

    const session = this.getSession(id);
    if (!session) throw new Error('Failed to load created agent session');
    return session;
  }

  getSession(sessionId: string): AgentSessionRecord | null {
    const db = getDatabase();
    const row = db
      .query('SELECT * FROM agent_sessions WHERE id = ?')
      .get(sessionId) as AgentSessionRow | null;
    return row ? toSessionRecord(row) : null;
  }

  appendMessage(input: AppendAgentMessageInput): AgentMessageRecord {
    const db = getDatabase();
    const id = input.id ?? randomUUID();
    const sequence = nextSequence('agent_messages', 'session_id', input.sessionId);
    db.query(
      `INSERT INTO agent_messages (id, session_id, sequence, role, content_json, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.sessionId,
      sequence,
      input.role,
      stringifyJson(input.content),
      stringifyJson(input.metadata ?? {})
    );
    return this.getMessage(id) as AgentMessageRecord;
  }

  appendToolCall(input: AppendAgentToolCallInput): AgentToolCallRecord {
    const db = getDatabase();
    const id = input.id ?? randomUUID();
    const status = input.status ?? 'completed';
    const sequence = nextSequence('agent_tool_calls', 'session_id', input.sessionId);
    db.query(
      `INSERT INTO agent_tool_calls (
         id, session_id, message_id, sequence, tool_name, status, arguments_json, result_json, error_json, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.sessionId,
      input.messageId ?? null,
      sequence,
      input.toolName,
      status,
      stringifyJson(input.arguments ?? {}),
      input.result === undefined ? null : stringifyJson(input.result),
      input.error === undefined ? null : stringifyJson(input.error),
      status === 'running' ? null : new Date().toISOString()
    );
    return this.getToolCall(id) as AgentToolCallRecord;
  }

  createInvocation(input: CreateAgentInvocationInput): AgentInvocationRecord {
    const db = getDatabase();
    const id = input.id ?? randomUUID();
    const sequence = nextSequence('agent_invocations', 'parent_session_id', input.parentSessionId);
    db.query(
      `INSERT INTO agent_invocations (
         id, parent_session_id, child_session_id, sequence, agent_type, model, status, input_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.parentSessionId,
      input.childSessionId ?? null,
      sequence,
      input.agentType,
      input.model,
      input.status ?? 'running',
      stringifyJson(input.input ?? {})
    );
    return this.getInvocation(id) as AgentInvocationRecord;
  }

  completeSession(input: CompleteAgentSessionInput): AgentSessionRecord {
    const db = getDatabase();
    db.query(
      `UPDATE agent_sessions
       SET status = ?, final_result_json = ?, error_json = ?, completed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      input.status,
      input.finalResult === undefined ? null : stringifyJson(input.finalResult),
      input.error === undefined ? null : stringifyJson(input.error),
      input.sessionId
    );
    return this.getSession(input.sessionId) as AgentSessionRecord;
  }

  completeInvocation(input: CompleteAgentInvocationInput): AgentInvocationRecord {
    const db = getDatabase();
    db.query(
      `UPDATE agent_invocations
       SET status = ?, child_session_id = COALESCE(?, child_session_id), result_json = ?, error_json = ?, completed_at = datetime('now')
       WHERE id = ?`
    ).run(
      input.status,
      input.childSessionId ?? null,
      input.result === undefined ? null : stringifyJson(input.result),
      input.error === undefined ? null : stringifyJson(input.error),
      input.invocationId
    );
    return this.getInvocation(input.invocationId) as AgentInvocationRecord;
  }

  getSessionTree(rootSessionId: string): AgentSessionTree | null {
    const session = this.getSession(rootSessionId);
    if (!session) return null;

    const invocations = this.listInvocations(rootSessionId).map((invocation) => ({
      ...invocation,
      childSession: invocation.childSessionId
        ? (this.getSessionTree(invocation.childSessionId) ?? undefined)
        : undefined,
    }));

    return {
      ...session,
      messages: this.listMessages(rootSessionId),
      toolCalls: this.listToolCalls(rootSessionId),
      invocations,
    };
  }

  getSessionTreeByRunId(runId: string): AgentSessionTree | null {
    const db = getDatabase();
    const row = db
      .query(
        `SELECT id FROM agent_sessions 
       WHERE parent_session_id IS NULL 
         AND json_extract(metadata_json, '$.reviewRunId') = ?`
      )
      .get(runId) as { id: string } | null;

    if (!row) return null;
    return this.getSessionTree(row.id);
  }

  listMessages(sessionId: string): AgentMessageRecord[] {
    const db = getDatabase();
    const rows = db
      .query('SELECT * FROM agent_messages WHERE session_id = ? ORDER BY sequence ASC')
      .all(sessionId) as AgentMessageRow[];
    return rows.map(toMessageRecord);
  }

  listToolCalls(sessionId: string): AgentToolCallRecord[] {
    const db = getDatabase();
    const rows = db
      .query('SELECT * FROM agent_tool_calls WHERE session_id = ? ORDER BY sequence ASC')
      .all(sessionId) as AgentToolCallRow[];
    return rows.map(toToolCallRecord);
  }

  listInvocations(parentSessionId: string): AgentInvocationRecord[] {
    const db = getDatabase();
    const rows = db
      .query('SELECT * FROM agent_invocations WHERE parent_session_id = ? ORDER BY sequence ASC')
      .all(parentSessionId) as AgentInvocationRow[];
    return rows.map(toInvocationRecord);
  }

  getInvocationTranscript(invocationId: string): AgentInvocationTranscript | null {
    const invocation = this.getInvocation(invocationId);
    if (!invocation) return null;

    return {
      invocation,
      childSession: invocation.childSessionId
        ? (this.getSessionTree(invocation.childSessionId) ?? undefined)
        : undefined,
    };
  }

  private getMessage(messageId: string): AgentMessageRecord | null {
    const db = getDatabase();
    const row = db
      .query('SELECT * FROM agent_messages WHERE id = ?')
      .get(messageId) as AgentMessageRow | null;
    return row ? toMessageRecord(row) : null;
  }

  private getToolCall(toolCallId: string): AgentToolCallRecord | null {
    const db = getDatabase();
    const row = db
      .query('SELECT * FROM agent_tool_calls WHERE id = ?')
      .get(toolCallId) as AgentToolCallRow | null;
    return row ? toToolCallRecord(row) : null;
  }

  private getInvocation(invocationId: string): AgentInvocationRecord | null {
    const db = getDatabase();
    const row = db
      .query('SELECT * FROM agent_invocations WHERE id = ?')
      .get(invocationId) as AgentInvocationRow | null;
    return row ? toInvocationRecord(row) : null;
  }
}

export const agentSessionRepository = new AgentSessionRepository();
