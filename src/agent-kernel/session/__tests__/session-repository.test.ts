import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getDatabase, initDatabase } from '../../../db/database';
import { agentSessionRepository } from '../session-repository';

describe('agentSessionRepository', () => {
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(() => {
    const tmpDir = join(tmpdir(), `agent-session-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, 'test.db');
    process.env.DATABASE_PATH = dbPath;
    initDatabase();
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

  test('migration creates transcript tables and can run idempotently', () => {
    const db = getDatabase();
    const rows = db
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'agent_sessions', 'agent_messages', 'agent_tool_calls', 'agent_invocations'
         )
         ORDER BY name`
      )
      .all() as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual([
      'agent_invocations',
      'agent_messages',
      'agent_sessions',
      'agent_tool_calls',
    ]);

    closeDatabase();
    initDatabase();

    const migrationRow = getDatabase()
      .query('SELECT COUNT(*) AS count FROM _migrations WHERE version = 5')
      .get() as { count: number };
    expect(migrationRow.count).toBe(1);
  });

  test('queries parent-child transcript tree in insertion order', () => {
    const parent = agentSessionRepository.createSession({
      agentType: 'main',
      model: 'gpt-main',
      metadata: { requestId: 'req-1' },
    });
    const secondMessage = agentSessionRepository.appendMessage({
      sessionId: parent.id,
      role: 'assistant',
      content: { text: 'second' },
    });
    agentSessionRepository.appendMessage({
      sessionId: parent.id,
      role: 'user',
      content: { text: 'first but inserted second' },
    });
    agentSessionRepository.appendToolCall({
      sessionId: parent.id,
      messageId: secondMessage.id,
      toolName: 'search_code',
      arguments: { query: 'alpha' },
      result: { matches: 1 },
    });
    agentSessionRepository.appendToolCall({
      sessionId: parent.id,
      toolName: 'read_file',
      arguments: { path: 'src/index.ts' },
      result: { content: 'ok' },
    });

    const firstInvocation = agentSessionRepository.createInvocation({
      parentSessionId: parent.id,
      agentType: 'security-reviewer',
      model: 'gpt-sub-a',
      input: { goal: 'security' },
    });
    const secondInvocation = agentSessionRepository.createInvocation({
      parentSessionId: parent.id,
      agentType: 'quality-reviewer',
      model: 'gpt-sub-b',
      input: { goal: 'quality' },
    });
    const child = agentSessionRepository.createSession({
      parentSessionId: parent.id,
      parentInvocationId: firstInvocation.id,
      agentType: 'security-reviewer',
      model: 'gpt-sub-a',
    });
    agentSessionRepository.appendMessage({
      sessionId: child.id,
      role: 'assistant',
      content: { text: 'child transcript' },
    });
    agentSessionRepository.completeInvocation({
      invocationId: firstInvocation.id,
      status: 'completed',
      result: { summary: 'done' },
      childSessionId: child.id,
    });
    agentSessionRepository.completeInvocation({
      invocationId: secondInvocation.id,
      status: 'failed',
      error: { message: 'boom' },
    });
    agentSessionRepository.completeSession({
      sessionId: parent.id,
      status: 'completed',
      finalResult: { summary: 'parent done' },
    });

    const tree = agentSessionRepository.getSessionTree(parent.id);
    expect(tree?.agentType).toBe('main');
    expect(tree?.messages.map((message) => message.content)).toEqual([
      { text: 'second' },
      { text: 'first but inserted second' },
    ]);
    expect(tree?.toolCalls.map((toolCall) => toolCall.toolName)).toEqual([
      'search_code',
      'read_file',
    ]);
    expect(tree?.invocations.map((invocation) => invocation.agentType)).toEqual([
      'security-reviewer',
      'quality-reviewer',
    ]);
    expect(tree?.invocations[0].childSession?.messages[0].content).toEqual({
      text: 'child transcript',
    });
    expect(tree?.invocations[1].error).toEqual({ message: 'boom' });

    const completedTranscript = agentSessionRepository.getInvocationTranscript(firstInvocation.id);
    expect(completedTranscript?.invocation.id).toBe(firstInvocation.id);
    expect(completedTranscript?.childSession?.id).toBe(child.id);
    expect(completedTranscript?.childSession?.messages[0].content).toEqual({
      text: 'child transcript',
    });

    const failedTranscript = agentSessionRepository.getInvocationTranscript(secondInvocation.id);
    expect(failedTranscript?.invocation.id).toBe(secondInvocation.id);
    expect(failedTranscript?.childSession).toBeUndefined();
    expect(agentSessionRepository.getInvocationTranscript('missing-invocation')).toBeNull();
  });

  test('redacts sensitive JSON fields before storage', () => {
    const session = agentSessionRepository.createSession({
      agentType: 'main',
      model: 'gpt-main',
      metadata: {
        apiKey: 'sk-live',
        nested: { authorization: 'Bearer token', safe: 'visible' },
      },
    });

    agentSessionRepository.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: { password: 'p4ss', text: 'keep me' },
    });
    agentSessionRepository.appendToolCall({
      sessionId: session.id,
      toolName: 'call_provider',
      arguments: { token: 'tok_123', payload: { secret: 'hidden', value: 1 } },
      result: { ok: true, refreshToken: 'refresh_123' },
    });
    agentSessionRepository.completeSession({
      sessionId: session.id,
      status: 'failed',
      error: { message: 'bad', credentials: { api_key: 'secret-key' } },
    });

    const tree = agentSessionRepository.getSessionTree(session.id);
    expect(tree?.metadata).toEqual({
      apiKey: '[REDACTED]',
      nested: { authorization: '[REDACTED]', safe: 'visible' },
    });
    expect(tree?.messages[0].content).toEqual({ password: '[REDACTED]', text: 'keep me' });
    expect(tree?.toolCalls[0].arguments).toEqual({
      token: '[REDACTED]',
      payload: { secret: '[REDACTED]', value: 1 },
    });
    expect(tree?.toolCalls[0].result).toEqual({ ok: true, refreshToken: '[REDACTED]' });
    expect(tree?.error).toEqual({
      message: 'bad',
      credentials: '[REDACTED]',
    });
  });

  test('getSessionTreeByRunId finds the correct session tree by reviewRunId', () => {
    const runId = 'test-run-123';
    const session = agentSessionRepository.createSession({
      agentType: 'review-main-agent',
      model: 'gpt-main',
      metadata: { reviewRunId: runId },
    });

    const tree = agentSessionRepository.getSessionTreeByRunId(runId);
    expect(tree).not.toBeNull();
    expect(tree?.id).toBe(session.id);
    expect(tree?.metadata.reviewRunId).toBe(runId);

    const missingTree = agentSessionRepository.getSessionTreeByRunId('missing-run');
    expect(missingTree).toBeNull();
  });
});
