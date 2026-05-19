import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabase, initDatabase } from '../../db/database';
import { kernelSessionRepository } from '../session/session-repository';

describe('KernelSessionRepository subagent invocations', () => {
  let tempDir: string;
  let savedDbPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'kernel-subagent-db-'));
    savedDbPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = path.join(tempDir, 'assistant.db');
    initDatabase();
  });

  afterEach(async () => {
    closeDatabase();
    if (savedDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test('persists and lists subagent invocations', () => {
    const session = kernelSessionRepository.ensureSession({
      scopeType: 'pull_request',
      scopeKey: 'acme/repo#101',
      metadata: { owner: 'acme', repo: 'repo', prNumber: 101 },
      runId: 'run-101',
    });

    const invocation = kernelSessionRepository.createSubagentInvocation({
      parentSessionId: session.id,
      parentRunId: 'run-101',
      parentTaskName: 'custom:security-audit',
      subagentName: 'custom:security-audit',
      agentId: 'agent-123',
      packet: {
        goal: 'Review security issues',
        parentTaskName: 'custom:security-audit',
        input: { domain: 'security' },
        parentSessionId: session.id,
        parentRunId: 'run-101',
        contextSummary: 'summary',
      },
    });

    kernelSessionRepository.completeSubagentInvocation(invocation.id, 'completed', {
      agentId: 'agent-123',
      agentType: 'custom:security-audit',
      summary: 'security review done',
      totalDurationMs: 10,
      totalToolUseCount: 0,
      totalTokens: 0,
      artifacts: { findings: 2 },
    });

    const invocations = kernelSessionRepository.listSubagentInvocations(session.id);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.subagentName).toBe('custom:security-audit');
    expect(invocations[0]?.result?.summary).toBe('security review done');
  });
});
