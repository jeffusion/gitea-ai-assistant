import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabase, initDatabase } from '../../db/database';
import { kernelSessionRepository } from '../session/session-repository';

describe('KernelSessionRepository', () => {
  let tempDir: string;
  let savedDbPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'kernel-session-db-'));
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

  test('ensureSession reuses the same scope key and updates metadata', () => {
    const first = kernelSessionRepository.ensureSession({
      scopeType: 'pull_request',
      scopeKey: 'acme/repo#42',
      metadata: { owner: 'acme', repo: 'repo', prNumber: 42 },
      runId: 'run-1',
    });

    const second = kernelSessionRepository.ensureSession({
      scopeType: 'pull_request',
      scopeKey: 'acme/repo#42',
      metadata: { owner: 'acme', repo: 'repo', prNumber: 42, updated: true },
      runId: 'run-2',
    });

    expect(second.id).toBe(first.id);
    expect(second.lastRunId).toBe('run-2');
    expect(second.metadata).toEqual({ owner: 'acme', repo: 'repo', prNumber: 42, updated: true });
  });

  test('appendEvent and saveCheckpoint persist session runtime state', () => {
    const session = kernelSessionRepository.ensureSession({
      scopeType: 'pull_request',
      scopeKey: 'acme/repo#99',
      metadata: { owner: 'acme', repo: 'repo', prNumber: 99 },
      runId: 'run-99',
    });

    kernelSessionRepository.appendEvent(session.id, 'review_enqueued', { runId: 'run-99' });
    kernelSessionRepository.appendEvent(session.id, 'task_started', { name: 'prepare_workspace' });
    kernelSessionRepository.saveCheckpoint(session.id, {
      state: { prepared: true, findings: 3 },
      pendingTasks: [{ kind: 'skill', name: 'publish_review' }],
      stopReason: 'waiting',
    });

    const events = kernelSessionRepository.listEvents(session.id);
    const checkpoint = kernelSessionRepository.loadCheckpoint<{
      prepared: boolean;
      findings: number;
    }>(session.id);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'review_enqueued',
      'task_started',
    ]);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.state).toEqual({ prepared: true, findings: 3 });
    expect(checkpoint?.pendingTasks).toEqual([{ kind: 'skill', name: 'publish_review' }]);
    expect(checkpoint?.stopReason).toBe('waiting');
  });

  test('can query sessions by scope key and list sessions', () => {
    const first = kernelSessionRepository.ensureSession({
      scopeType: 'pull_request',
      scopeKey: 'acme/repo#1',
      metadata: { owner: 'acme', repo: 'repo', prNumber: 1 },
      runId: 'run-1',
    });
    const second = kernelSessionRepository.ensureSession({
      scopeType: 'pull_request',
      scopeKey: 'acme/repo#2',
      metadata: { owner: 'acme', repo: 'repo', prNumber: 2 },
      runId: 'run-2',
    });

    expect(kernelSessionRepository.getSessionByScopeKey('acme/repo#1')?.id).toBe(first.id);
    expect(kernelSessionRepository.listSessions(10).map((session) => session.id)).toEqual(
      expect.arrayContaining([first.id, second.id])
    );
  });
});
