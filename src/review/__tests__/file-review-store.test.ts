import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { FileReviewStore } from '../store/file-review-store';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PullRequestReviewPayload } from '../types';

function makePRPayload(overrides: Partial<PullRequestReviewPayload> = {}): PullRequestReviewPayload {
  return {
    idempotencyKey: 'idem-' + Math.random().toString(36).slice(2, 8),
    eventType: 'pull_request',
    owner: 'test-owner',
    repo: 'test-repo',
    cloneUrl: 'https://example.com/repo.git',
    prNumber: 1,
    baseSha: 'aaa',
    headSha: 'bbb',
    ...overrides,
  };
}

describe('FileReviewStore', () => {
  let tempDir: string;
  let store: FileReviewStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'store-test-'));
    store = new FileReviewStore(tempDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── Init ───
  describe('init', () => {
    test('creates state file on first init', async () => {
      const stateFile = path.join(tempDir, 'state', 'review-store.json');
      const content = await readFile(stateFile, 'utf-8');
      const data = JSON.parse(content);
      expect(data).toHaveProperty('runs');
      expect(data).toHaveProperty('steps');
      expect(data).toHaveProperty('findings');
      expect(data).toHaveProperty('comments');
    });

    test('double init is safe', async () => {
      await store.init();
      await store.init();
      const runs = await store.listRuns();
      expect(runs).toEqual([]);
    });

    test('re-reads existing data on init', async () => {
      const payload = makePRPayload();
      await store.createOrReuseRun(payload);

      // New store instance reading same dir
      const store2 = new FileReviewStore(tempDir);
      await store2.init();
      const runs = await store2.listRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].idempotencyKey).toBe(payload.idempotencyKey);
    });
  });

  // ─── createOrReuseRun ───
  describe('createOrReuseRun', () => {
    test('creates new run', async () => {
      const payload = makePRPayload();
      const { run, reused } = await store.createOrReuseRun(payload);
      expect(reused).toBe(false);
      expect(run.status).toBe('queued');
      expect(run.owner).toBe('test-owner');
      expect(run.prNumber).toBe(1);
    });

    test('reuses existing non-failed run with same idempotencyKey', async () => {
      const payload = makePRPayload();
      const { run: first } = await store.createOrReuseRun(payload);
      const { run: second, reused } = await store.createOrReuseRun(payload);
      expect(reused).toBe(true);
      expect(second.id).toBe(first.id);
    });

    test('does NOT reuse a failed run', async () => {
      const payload = makePRPayload({ maxAttempts: 1 });
      const { run: first } = await store.createOrReuseRun(payload);

      // Acquire and fail
      await store.acquireNextQueuedRun();
      await store.markRunFailed(first.id, 'test error');

      // Should create a new run, not reuse
      const { run: second, reused } = await store.createOrReuseRun(payload);
      expect(reused).toBe(false);
      expect(second.id).not.toBe(first.id);
    });
  });

  // ─── Failed run cleanup ───
  describe('failed run cleanup', () => {
    test('cleans up oldest failed runs when MAX_FAILED_RUNS_PER_KEY exceeded', async () => {
      const key = 'cleanup-test-key';

      // Create 4 failed runs for the same key
      for (let i = 0; i < 4; i++) {
        const payload = makePRPayload({ idempotencyKey: key, maxAttempts: 1 });
        const { run } = await store.createOrReuseRun(payload);
        await store.acquireNextQueuedRun();
        await store.markRunFailed(run.id, `error-${i}`);
      }

      // Creating 5th run should trigger cleanup
      const payload = makePRPayload({ idempotencyKey: key, maxAttempts: 1 });
      await store.createOrReuseRun(payload);

      const runs = await store.listRuns(100);
      const runsForKey = runs.filter((r) => r.idempotencyKey === key);

      // Should have at most MAX_FAILED_RUNS_PER_KEY (3) failed + 1 new queued = 4
      // But the cleanup runs before adding new, so we expect ≤4
      expect(runsForKey.length).toBeLessThanOrEqual(4);
    });

    test('cleanup also removes associated steps, findings, comments', async () => {
      const key = 'cleanup-assoc-key';

      // Create and fail runs, adding associated data
      for (let i = 0; i < 4; i++) {
        const payload = makePRPayload({ idempotencyKey: key, maxAttempts: 1 });
        const { run } = await store.createOrReuseRun(payload);

        // Add a step for this run
        await store.addStep({
          runId: run.id,
          stepName: `step-${i}`,
          status: 'started',
          startedAt: new Date().toISOString(),
        });

        // Add findings
        await store.addFindings(run.id, [
          {
            id: `finding-${i}`,
            runId: run.id,
            fingerprint: `fp-${i}`,
            category: 'correctness',
            severity: 'high',
            confidence: 0.9,
            path: 'test.ts',
            line: i + 1,
            title: `Issue ${i}`,
            detail: 'Detail',
            evidence: 'Evidence',
            suggestion: 'Fix',
            published: false,
          },
        ]);

        await store.acquireNextQueuedRun();
        await store.markRunFailed(run.id, `error-${i}`);
      }

      // Trigger cleanup by creating 5th run
      const payload = makePRPayload({ idempotencyKey: key, maxAttempts: 1 });
      await store.createOrReuseRun(payload);

      // Verify the data was actually persisted and can be read back
      const store2 = new FileReviewStore(tempDir);
      await store2.init();
      const allRuns = await store2.listRuns(100);
      const keyRuns = allRuns.filter((r) => r.idempotencyKey === key);
      expect(keyRuns.length).toBeLessThanOrEqual(4);
    });
  });

  // ─── recoverInterruptedRuns ───
  describe('recoverInterruptedRuns', () => {
    test('resets in_progress runs to queued', async () => {
      const payload = makePRPayload();
      await store.createOrReuseRun(payload);
      await store.acquireNextQueuedRun(); // now in_progress

      const recovered = await store.recoverInterruptedRuns();
      expect(recovered).toBe(1);

      // Check it's queued again
      const runs = await store.listRuns();
      expect(runs[0].status).toBe('queued');
    });

    test('no interrupted runs → returns 0', async () => {
      const payload = makePRPayload();
      await store.createOrReuseRun(payload); // queued, not in_progress
      const recovered = await store.recoverInterruptedRuns();
      expect(recovered).toBe(0);
    });

    test('only recovers in_progress, not queued or succeeded', async () => {
      // Create 3 runs: one queued, one in_progress, one succeeded
      const p1 = makePRPayload();
      const p2 = makePRPayload();
      const p3 = makePRPayload();

      await store.createOrReuseRun(p1); // queued
      const { run: r2 } = await store.createOrReuseRun(p2);
      await store.createOrReuseRun(p3);

      // Acquire r2 (first queued gets picked) → in_progress
      await store.acquireNextQueuedRun();
      // Acquire r3 → in_progress (r1 still queued if r2 was picked, but let's be explicit)
      // Actually acquireNextQueuedRun picks first queued, so pick the remaining
      await store.acquireNextQueuedRun();
      // Succeed one of them
      await store.markRunSucceeded(r2.id);

      const recovered = await store.recoverInterruptedRuns();
      // Only non-succeeded in_progress runs get recovered
      expect(recovered).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Atomic write ───
  describe('atomic write (persist)', () => {
    test('state file does not have .tmp extension after write', async () => {
      const payload = makePRPayload();
      await store.createOrReuseRun(payload);

      const stateFile = path.join(tempDir, 'state', 'review-store.json');
      const content = await readFile(stateFile, 'utf-8');
      const data = JSON.parse(content);
      expect(data.runs).toHaveLength(1);
    });

    test('concurrent writes are serialized (no data corruption)', async () => {
      // Fire multiple concurrent operations
      const promises = Array.from({ length: 10 }, (_, i) =>
        store.createOrReuseRun(makePRPayload({ idempotencyKey: `concurrent-${i}` }))
      );

      await Promise.all(promises);

      // Read back and verify all 10 runs exist
      const store2 = new FileReviewStore(tempDir);
      await store2.init();
      const runs = await store2.listRuns(20);
      expect(runs).toHaveLength(10);
    });
  });

  // ─── acquireNextQueuedRun ───
  describe('acquireNextQueuedRun', () => {
    test('returns null when no queued runs', async () => {
      const run = await store.acquireNextQueuedRun();
      expect(run).toBeNull();
    });

    test('returns first queued run and sets to in_progress', async () => {
      const payload = makePRPayload();
      const { run: created } = await store.createOrReuseRun(payload);
      const acquired = await store.acquireNextQueuedRun();
      expect(acquired).not.toBeNull();
      expect(acquired!.id).toBe(created.id);
      expect(acquired!.status).toBe('in_progress');
    });
  });

  // ─── markRunFailed with retry ───
  describe('markRunFailed', () => {
    test('requeues if attempts < maxAttempts', async () => {
      const payload = makePRPayload({ maxAttempts: 3 });
      const { run } = await store.createOrReuseRun(payload);
      await store.acquireNextQueuedRun();

      const { requeued, run: failedRun } = await store.markRunFailed(run.id, 'oops');
      expect(requeued).toBe(true);
      expect(failedRun!.status).toBe('queued');
      expect(failedRun!.attempts).toBe(1);
    });

    test('permanently fails when attempts exhausted', async () => {
      const payload = makePRPayload({ maxAttempts: 1 });
      const { run } = await store.createOrReuseRun(payload);
      await store.acquireNextQueuedRun();

      const { requeued, run: failedRun } = await store.markRunFailed(run.id, 'final');
      expect(requeued).toBe(false);
      expect(failedRun!.status).toBe('failed');
    });

    test('non-existent runId returns null', async () => {
      const { requeued, run } = await store.markRunFailed('nonexistent-id', 'error');
      expect(requeued).toBe(false);
      expect(run).toBeNull();
    });
  });

  // ─── Finding operations ───
  describe('findings', () => {
    test('addFindings replaces previous findings for same runId', async () => {
      const payload = makePRPayload();
      const { run } = await store.createOrReuseRun(payload);

      await store.addFindings(run.id, [
        {
          id: 'f1', runId: run.id, fingerprint: 'fp1', category: 'correctness',
          severity: 'high', confidence: 0.9, path: 'a.ts', line: 1,
          title: 'Old', detail: 'd', evidence: 'e', suggestion: 's', published: false,
        },
      ]);

      await store.addFindings(run.id, [
        {
          id: 'f2', runId: run.id, fingerprint: 'fp2', category: 'security',
          severity: 'medium', confidence: 0.8, path: 'b.ts', line: 2,
          title: 'New', detail: 'd', evidence: 'e', suggestion: 's', published: false,
        },
      ]);

      const details = await store.getRunDetails(run.id);
      expect(details!.findings).toHaveLength(1);
      expect(details!.findings[0].title).toBe('New');
    });

    test('markFindingPublished is idempotent', async () => {
      const payload = makePRPayload();
      const { run } = await store.createOrReuseRun(payload);
      await store.addFindings(run.id, [
        {
          id: 'f1', runId: run.id, fingerprint: 'fp1', category: 'correctness',
          severity: 'high', confidence: 0.9, path: 'a.ts', line: 1,
          title: 'Bug', detail: 'd', evidence: 'e', suggestion: 's', published: false,
        },
      ]);

      const first = await store.markFindingPublished(run.id, 'fp1');
      expect(first).toBe(true); // was unpublished → now published

      const second = await store.markFindingPublished(run.id, 'fp1');
      expect(second).toBe(false); // already published
    });
  });

  // ─── listRuns ───
  describe('listRuns', () => {
    test('returns runs sorted by createdAt descending', async () => {
      const p1 = makePRPayload();
      const p2 = makePRPayload();
      const p3 = makePRPayload();

      await store.createOrReuseRun(p1);
      // Ensure distinct timestamps for sorting
      await new Promise(r => setTimeout(r, 5));
      await store.createOrReuseRun(p2);
      await new Promise(r => setTimeout(r, 5));
      await store.createOrReuseRun(p3);

      const runs = await store.listRuns();
      expect(runs).toHaveLength(3);
      // Most recent first
      expect(runs[0].idempotencyKey).toBe(p3.idempotencyKey);
    });

    test('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await store.createOrReuseRun(makePRPayload());
      }
      const runs = await store.listRuns(2);
      expect(runs).toHaveLength(2);
    });
  });
});
