import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabase, initDatabase } from '../../db/database';
import { getKernelAgentContext } from '../agents/kernel-agent-context';
import { KernelAgentInvoker } from '../agents/kernel-agent-invoker';
import { KernelAgentRegistry } from '../agents/kernel-agent-registry';
import { kernelSessionRepository } from '../session/session-repository';

interface DummyState {
  value: number;
}

describe('KernelAgentInvoker', () => {
  let tempDir: string;
  let savedDbPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'kernel-agent-invoker-db-'));
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

  test('invokes subagent with isolated agent context and structured result', async () => {
    const session = kernelSessionRepository.ensureSession({
      scopeType: 'pull_request',
      scopeKey: 'acme/repo#88',
      metadata: { owner: 'acme', repo: 'repo', prNumber: 88 },
      runId: 'run-88',
    });

    const registry = new KernelAgentRegistry<DummyState>();
    registry.register({
      kind: 'subagent',
      name: 'test:subagent',
      source: 'built-in',
      description: 'Test subagent',
      whenToUse: 'Used by invoker test',
      tags: ['test'],
      execute: async (_task, context) => {
        const agentContext = getKernelAgentContext();
        expect(agentContext?.agentType).toBe('subagent');
        expect(agentContext?.subagentName).toBe('test:subagent');
        expect(context.delegation.parentSessionId).toBe(session.id);

        return {
          state: { value: context.state.value + 1 },
          summary: 'subagent completed',
          artifacts: { nextValue: context.state.value + 1 },
        };
      },
    });

    const invoker = new KernelAgentInvoker(registry);
    const output = await invoker.invoke(
      { kind: 'subagent', name: 'test:subagent', input: { focus: 'test' } },
      {
        session,
        runId: 'run-88',
        state: { value: 1 },
      }
    );

    expect(output.result?.state).toEqual({ value: 2 });
    expect(output.invocation.status).toBe('completed');
    expect(output.invocation.result?.summary).toBe('subagent completed');
    expect(output.invocation.result?.artifacts).toEqual({ nextValue: 2 });
  });
});
