import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabase, initDatabase } from '../../db/database';
import { KernelAgentInvoker } from '../agents/kernel-agent-invoker';
import { KernelAgentRegistry } from '../agents/kernel-agent-registry';
import { KernelTaskRegistry } from '../registry/kernel-task-registry';
import { AgentKernelRunner } from '../runtime/agent-kernel-runner';
import { kernelSessionRepository } from '../session/session-repository';

interface DummyState {
  counter: number;
}

describe('AgentKernelRunner', () => {
  let tempDir: string;
  let savedDbPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'kernel-runner-db-'));
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

  test('runs queued skills and subagents and persists checkpoint', async () => {
    const session = kernelSessionRepository.ensureSession({
      scopeType: 'pull_request',
      scopeKey: 'acme/repo#7',
      metadata: { owner: 'acme', repo: 'repo', prNumber: 7 },
      runId: 'run-7',
    });

    const skillRegistry = new KernelTaskRegistry<DummyState>();
    const subagentRegistry = new KernelAgentRegistry<DummyState>();

    skillRegistry.register({
      kind: 'skill',
      name: 'step_one',
      description: 'Initial skill for runner test',
      execute: async () => ({
        state: { counter: 1 },
        enqueue: [{ kind: 'subagent', name: 'step_two' }],
      }),
    });

    subagentRegistry.register({
      kind: 'subagent',
      name: 'step_two',
      source: 'built-in',
      whenToUse: 'Increment the test counter',
      description: 'Test subagent used by runner tests',
      execute: async (_task, context) => ({
        state: { counter: context.state.counter + 1 },
      }),
    });

    const runner = new AgentKernelRunner(skillRegistry, new KernelAgentInvoker(subagentRegistry), {
      plan: () => [],
    });
    const checkpoint = await runner.run({
      sessionId: session.id,
      runId: 'run-7',
      initialState: { counter: 0 },
      initialTasks: [{ kind: 'skill', name: 'step_one' }],
    });

    const events = kernelSessionRepository.listEvents(session.id);

    expect(checkpoint.state.counter).toBe(2);
    expect(checkpoint.pendingTasks).toHaveLength(0);
    expect(checkpoint.stopReason).toBe('completed');
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'task_completed',
      'task_completed',
      'task_started',
      'task_started',
    ]);
  });

  test('continueExisting ignores persisted stop reason and resumes planned work', async () => {
    const session = kernelSessionRepository.ensureSession({
      scopeType: 'pull_request',
      scopeKey: 'acme/repo#8',
      metadata: { owner: 'acme', repo: 'repo', prNumber: 8 },
      runId: 'run-8',
    });

    kernelSessionRepository.saveCheckpoint(session.id, {
      state: { counter: 1 },
      pendingTasks: [],
      stopReason: 'awaiting_human_feedback',
    });

    const skillRegistry = new KernelTaskRegistry<DummyState>();
    const subagentRegistry = new KernelAgentRegistry<DummyState>();

    skillRegistry.register({
      kind: 'skill',
      name: 'resume_step',
      description: 'Resume skill for runner test',
      execute: async (_task, context) => ({
        state: { counter: context.state.counter + 1 },
      }),
    });

    const runner = new AgentKernelRunner(skillRegistry, new KernelAgentInvoker(subagentRegistry), {
      plan: (context) =>
        context.state.counter < 2 ? [{ kind: 'skill', name: 'resume_step' }] : [],
    });

    const checkpoint = await runner.run({
      sessionId: session.id,
      runId: 'run-8',
      initialState: { counter: 0 },
      initialTasks: [],
      continueExisting: true,
    });

    expect(checkpoint.state.counter).toBe(2);
    expect(checkpoint.stopReason).toBe('completed');
  });
});
