import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JudgeAgent } from '../agents/judge-agent';
import type { TriageResult } from '../agents/triage-agent';
import type { DiffExtractor } from '../context/diff-extractor';
import type { LocalRepoManager } from '../context/local-repo-manager';
import { ReviewOrchestrator } from '../orchestrator';
import { applyPublishPolicy } from '../policy/publish-policy';
import { FileReviewStore } from '../store/file-review-store';
import type { Finding, PullRequestReviewPayload, ReviewContext, ReviewRun } from '../types';

type PartialFinding = Omit<Finding, 'id' | 'runId' | 'published'>;

function makePRPayload(
  overrides: Partial<PullRequestReviewPayload> = {}
): PullRequestReviewPayload {
  return {
    idempotencyKey: 'test/repo#1:aaa...bbb',
    eventType: 'pull_request',
    owner: 'test-owner',
    repo: 'test-repo',
    cloneUrl: 'https://gitea.example.com/test-owner/test-repo.git',
    prNumber: 1,
    baseSha: 'aaa',
    headSha: 'bbb',
    ...overrides,
  };
}

function makeAgentFindings(
  count: number,
  severity: 'high' | 'medium' | 'low' = 'high'
): PartialFinding[] {
  return Array.from({ length: count }, (_, i) => ({
    fingerprint: `fp-${severity}-${i}`,
    category: 'correctness' as const,
    severity,
    confidence: severity === 'high' ? 0.95 : severity === 'medium' ? 0.85 : 0.7,
    path: `src/file${i}.ts`,
    line: 10 + i,
    title: `${severity} issue ${i}`,
    detail: `Detail for ${severity} issue ${i}`,
    evidence: `Evidence ${i}`,
    suggestion: `Fix suggestion ${i}`,
  }));
}

function makeReviewContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    workspacePath: '/tmp/workspace',
    mirrorPath: '/tmp/mirror',
    diff: 'diff --git a/src/core.ts b/src/core.ts\n+export const a = 1;',
    changedFiles: [{ path: 'src/core.ts', status: 'M', additions: 1, deletions: 0 }],
    parsedDiff: [
      {
        path: 'src/core.ts',
        changes: [{ lineNumber: 1, oldLineNumber: 1, content: 'export const a = 1;', type: 'add' }],
      },
    ],
    fileContents: { 'src/core.ts': 'export const a = 1;' },
    ...overrides,
  };
}

function createOrchestratorDeps(context: ReviewContext) {
  const localRepoManager = {
    prepareWorkspace: mock(async () => ({
      mirrorPath: '/tmp/mirror',
      workspacePath: '/tmp/workspace',
    })),
    resolveReviewedRef: mock(async () => null),
    saveReviewedRef: mock(async () => undefined),
    cleanupWorkspace: mock(async () => undefined),
  };

  const diffExtractor = {
    getSandbox: mock(() => ({
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    })),
    buildContext: mock(async () => context),
  };

  return {
    localRepoManager,
    diffExtractor,
  };
}

/**
 * Integration tests: Store → JudgeAgent → PublishPolicy → Store pipeline
 *
 * These tests simulate the orchestrator's data flow without needing
 * live OpenAI or Gitea services. They verify that the pipeline from
 * enqueueing a run through judging findings to applying publish policy
 * works correctly end-to-end.
 */
describe('Integration: Store → Judge → Policy pipeline', () => {
  let tempDir: string;
  let store: FileReviewStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'integration-test-'));
    store = new FileReviewStore(tempDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('full pipeline: enqueue → agent findings → judge dedup → policy → store findings → publish mark', async () => {
    const payload = makePRPayload();
    const { run, reused } = await store.createOrReuseRun(payload);
    expect(reused).toBe(false);
    expect(run.status).toBe('queued');

    const acquired = await store.acquireNextQueuedRun();
    expect(acquired).not.toBeNull();
    expect(acquired!.status).toBe('in_progress');

    await store.addStep({
      runId: run.id,
      stepName: 'run_specialists',
      status: 'started',
      startedAt: new Date().toISOString(),
    });

    const correctnessFindings = makeAgentFindings(2, 'high');
    const securityFindings = makeAgentFindings(1, 'medium');
    const lowFindings = makeAgentFindings(1, 'low');

    const duplicateFinding: PartialFinding = {
      ...correctnessFindings[0],
      confidence: 0.7,
      detail: 'Duplicate with lower confidence',
    };

    const allAgentFindings = [
      ...correctnessFindings,
      ...securityFindings,
      ...lowFindings,
      duplicateFinding,
    ];

    const judge = new JudgeAgent();
    const decision = judge.judge(allAgentFindings);

    expect(decision.findings.length).toBe(4);
    const dedupedFp0 = decision.findings.find((f) => f.fingerprint === 'fp-high-0');
    expect(dedupedFp0!.confidence).toBe(0.95);

    const policyResult = applyPublishPolicy(decision.findings, 0.8, false);

    expect(policyResult.publishable.length).toBe(3);
    expect(policyResult.gated.length).toBe(0);
    expect(policyResult.dropped.length).toBe(1);
    expect(policyResult.dropped[0].severity).toBe('low');

    const findingsToStore = [...policyResult.publishable, ...policyResult.gated];
    const persistedFindings: Finding[] = findingsToStore.map((f, i) => ({
      ...f,
      id: `finding-${i}`,
      runId: run.id,
      published: false,
    }));
    await store.addFindings(run.id, persistedFindings);

    for (const finding of policyResult.publishable) {
      const wasNew = await store.markFindingPublished(run.id, finding.fingerprint);
      expect(wasNew).toBe(true);
    }

    for (const finding of policyResult.publishable) {
      const wasNew = await store.markFindingPublished(run.id, finding.fingerprint);
      expect(wasNew).toBe(false);
    }

    await store.addCommentRecord({
      runId: run.id,
      status: 'published',
      body: `## AI Agent代码审查结果\n\n${decision.summaryMarkdown}`,
    });

    for (const finding of policyResult.publishable) {
      await store.addCommentRecord({
        runId: run.id,
        status: 'published',
        path: finding.path,
        line: finding.line,
        body: `**[${finding.severity.toUpperCase()}]** ${finding.title}`,
      });
    }

    await store.markRunSucceeded(run.id);

    const details = await store.getRunDetails(run.id);
    expect(details).not.toBeNull();
    expect(details!.run.status).toBe('succeeded');
    expect(details!.findings.length).toBe(3);
    expect(details!.findings.every((f) => f.published)).toBe(true);
    expect(details!.comments.length).toBe(4);
    expect(details!.comments.filter((c) => !c.path).length).toBe(1);
    expect(details!.comments.filter((c) => c.path).length).toBe(3);
  });

  test('pipeline with humanGate: low-confidence findings go to gated, not dropped', async () => {
    const payload = makePRPayload({ idempotencyKey: 'gate-test' });
    const { run } = await store.createOrReuseRun(payload);
    await store.acquireNextQueuedRun();

    const findings: PartialFinding[] = [
      ...makeAgentFindings(1, 'high'),
      {
        fingerprint: 'fp-low-conf',
        category: 'security',
        severity: 'high',
        confidence: 0.5,
        path: 'src/auth.ts',
        line: 20,
        title: 'Potential auth bypass',
        detail: 'Detail',
        evidence: 'Evidence',
        suggestion: 'Fix',
      },
    ];

    const judge = new JudgeAgent();
    const decision = judge.judge(findings);
    const policyResult = applyPublishPolicy(decision.findings, 0.8, true);

    expect(policyResult.publishable.length).toBe(1);
    expect(policyResult.gated.length).toBe(1);
    expect(policyResult.dropped.length).toBe(0);
    expect(policyResult.gated[0].fingerprint).toBe('fp-low-conf');

    const allToStore = [...policyResult.publishable, ...policyResult.gated];
    const persisted: Finding[] = allToStore.map((f, i) => ({
      ...f,
      id: `f-${i}`,
      runId: run.id,
      published: false,
    }));
    await store.addFindings(run.id, persisted);

    for (const f of policyResult.publishable) {
      await store.markFindingPublished(run.id, f.fingerprint);
    }

    for (const f of policyResult.gated) {
      await store.addCommentRecord({
        runId: run.id,
        status: 'pending',
        path: f.path,
        line: f.line,
        body: `PENDING: ${f.title}`,
        fingerprint: f.fingerprint,
      });
    }

    const details = await store.getRunDetails(run.id);
    const pendingComments = details!.comments.filter((c) => c.status === 'pending');
    expect(pendingComments.length).toBe(1);
    expect(pendingComments[0].fingerprint).toBe('fp-low-conf');

    const unpublished = details!.findings.filter((f) => !f.published);
    expect(unpublished.length).toBe(1);
    expect(unpublished[0].fingerprint).toBe('fp-low-conf');
  });

  test('idempotency: duplicate webhook enqueue returns same run', async () => {
    const payload = makePRPayload();

    const { run: first, reused: r1 } = await store.createOrReuseRun(payload);
    expect(r1).toBe(false);

    const { run: second, reused: r2 } = await store.createOrReuseRun(payload);
    expect(r2).toBe(true);
    expect(second.id).toBe(first.id);

    const { run: third, reused: r3 } = await store.createOrReuseRun(payload);
    expect(r3).toBe(true);
    expect(third.id).toBe(first.id);
  });

  test('retry flow: failed run creates new run on next enqueue, old steps/findings preserved', async () => {
    const payload = makePRPayload({ maxAttempts: 1 });
    const { run: firstRun } = await store.createOrReuseRun(payload);

    await store.acquireNextQueuedRun();
    await store.addStep({
      runId: firstRun.id,
      stepName: 'prepare_workspace',
      status: 'failed',
      startedAt: new Date().toISOString(),
      error: 'git clone failed',
    });
    await store.markRunFailed(firstRun.id, 'git clone failed');

    const firstDetails = await store.getRunDetails(firstRun.id);
    expect(firstDetails!.run.status).toBe('failed');
    expect(firstDetails!.steps.length).toBe(1);

    const { run: retryRun, reused } = await store.createOrReuseRun(payload);
    expect(reused).toBe(false);
    expect(retryRun.id).not.toBe(firstRun.id);

    const retryAcquired = await store.acquireNextQueuedRun();
    expect(retryAcquired!.id).toBe(retryRun.id);
  });

  test('recovery after crash: in_progress runs are recovered to queued', async () => {
    const p1 = makePRPayload({ idempotencyKey: 'crash-1' });
    const p2 = makePRPayload({ idempotencyKey: 'crash-2' });

    const { run: run1 } = await store.createOrReuseRun(p1);
    const { run: run2 } = await store.createOrReuseRun(p2);

    await store.acquireNextQueuedRun();
    await store.acquireNextQueuedRun();

    await store.markRunSucceeded(run1.id);

    const store2 = new FileReviewStore(tempDir);
    await store2.init();
    const recovered = await store2.recoverInterruptedRuns();
    expect(recovered).toBe(1);

    const next = await store2.acquireNextQueuedRun();
    expect(next).not.toBeNull();
    expect(next!.id).toBe(run2.id);
  });

  test('concurrent enqueue: multiple payloads with different keys all get unique runs', async () => {
    const payloads = Array.from({ length: 5 }, (_, i) =>
      makePRPayload({ idempotencyKey: `concurrent-${i}`, prNumber: i + 1 })
    );

    const results = await Promise.all(payloads.map((p) => store.createOrReuseRun(p)));

    const ids = new Set(results.map((r) => r.run.id));
    expect(ids.size).toBe(5);
    expect(results.every((r) => !r.reused)).toBe(true);

    const runs = await store.listRuns(10);
    expect(runs.length).toBe(5);
  });

  test('end-to-end: no findings → summary only, no line comments', async () => {
    const payload = makePRPayload({ idempotencyKey: 'no-findings' });
    const { run } = await store.createOrReuseRun(payload);
    await store.acquireNextQueuedRun();

    const judge = new JudgeAgent();
    const decision = judge.judge([]);

    expect(decision.findings.length).toBe(0);
    expect(decision.summaryMarkdown).toContain('未发现');

    const policyResult = applyPublishPolicy(decision.findings, 0.8, false);
    expect(policyResult.publishable.length).toBe(0);
    expect(policyResult.gated.length).toBe(0);
    expect(policyResult.dropped.length).toBe(0);

    await store.addCommentRecord({
      runId: run.id,
      status: 'published',
      body: decision.summaryMarkdown,
    });

    await store.markRunSucceeded(run.id);

    const details = await store.getRunDetails(run.id);
    expect(details!.run.status).toBe('succeeded');
    expect(details!.findings.length).toBe(0);
    expect(details!.comments.length).toBe(1);
    expect(details!.comments[0].body).toContain('未发现');
  });

  test('store persistence: data survives across store instances', async () => {
    const payload = makePRPayload();
    const { run } = await store.createOrReuseRun(payload);
    await store.acquireNextQueuedRun();

    const findings: Finding[] = [
      {
        id: 'persist-f1',
        runId: run.id,
        fingerprint: 'persist-fp-1',
        category: 'security',
        severity: 'high',
        confidence: 0.95,
        path: 'src/auth.ts',
        line: 42,
        title: 'SQL injection',
        detail: 'Detail',
        evidence: 'Evidence',
        suggestion: 'Use parameterized queries',
        published: false,
      },
    ];
    await store.addFindings(run.id, findings);
    await store.markFindingPublished(run.id, 'persist-fp-1');
    await store.markRunSucceeded(run.id);

    const freshStore = new FileReviewStore(tempDir);
    await freshStore.init();

    const details = await freshStore.getRunDetails(run.id);
    expect(details).not.toBeNull();
    expect(details!.run.status).toBe('succeeded');
    expect(details!.findings.length).toBe(1);
    expect(details!.findings[0].published).toBe(true);
    expect(details!.findings[0].fingerprint).toBe('persist-fp-1');
  });
});

describe('Integration: orchestrator staged routing pipeline', () => {
  let tempDir: string;
  let store: FileReviewStore;

  beforeEach(async () => {
    mock.restore();
    tempDir = await mkdtemp(path.join(tmpdir(), 'orchestrator-integration-'));
    store = new FileReviewStore(tempDir);
    await store.init();
  });

  afterEach(async () => {
    mock.restore();
    await rm(tempDir, { recursive: true, force: true });
  });

  test('skip mode bypasses specialists end-to-end', async () => {
    const payload = makePRPayload({ idempotencyKey: 'stage-skip' });
    const { run } = await store.createOrReuseRun(payload);
    const acquired = await store.acquireNextQueuedRun();
    expect(acquired).not.toBeNull();

    const context = makeReviewContext({
      changedFiles: [{ path: 'README.md', status: 'M', additions: 2, deletions: 0 }],
      parsedDiff: [
        {
          path: 'README.md',
          changes: [{ lineNumber: 10, oldLineNumber: 10, content: 'new docs', type: 'add' }],
        },
      ],
      fileContents: { 'README.md': 'new docs' },
      diff: 'diff --git a/README.md b/README.md\n+new docs',
    });
    const { localRepoManager, diffExtractor } = createOrchestratorDeps(context);

    const orchestrator = new ReviewOrchestrator(
      store,
      localRepoManager as unknown as LocalRepoManager,
      diffExtractor as unknown as DiffExtractor
    );

    const internal = orchestrator as unknown as {
      triageAgent: { analyze: (ctx: ReviewContext) => Promise<TriageResult> };
      correctnessAgent: {
        reviewWithOptions: (
          runArg: ReviewRun,
          ctx: ReviewContext,
          options?: unknown
        ) => Promise<unknown>;
      };
      publishSummary: (runArg: ReviewRun, summary: string, gatedCount: number) => Promise<void>;
      publishLineComments: (
        runArg: ReviewRun,
        comments: Array<{ path: string; line: number; comment: string }>
      ) => Promise<boolean>;
    };

    internal.triageAgent = {
      analyze: mock(
        async (): Promise<TriageResult> => ({
          complexity: 'trivial',
          reviewSize: 'small',
          mode: 'skip',
          tasks: [],
          riskTags: [],
          rationale: 'docs-only',
        })
      ),
    };

    const correctnessSpy = mock(async () => ({ agentName: 'Correctness Agent', findings: [] }));
    internal.correctnessAgent.reviewWithOptions = correctnessSpy;
    internal.publishSummary = mock(async () => undefined);
    internal.publishLineComments = mock(async () => false);

    await orchestrator.execute(acquired!);

    expect(correctnessSpy).not.toHaveBeenCalled();

    const details = await store.getRunDetails(run.id);
    expect(details).not.toBeNull();
    expect(details!.findings).toHaveLength(0);
  });

  test('full task mode passes scoped options and publishes finding', async () => {
    const payload = makePRPayload({ idempotencyKey: 'stage-full' });
    const { run } = await store.createOrReuseRun(payload);
    const acquired = await store.acquireNextQueuedRun();
    expect(acquired).not.toBeNull();

    const context = makeReviewContext();
    const { localRepoManager, diffExtractor } = createOrchestratorDeps(context);

    const orchestrator = new ReviewOrchestrator(
      store,
      localRepoManager as unknown as LocalRepoManager,
      diffExtractor as unknown as DiffExtractor
    );

    const internal = orchestrator as unknown as {
      triageAgent: { analyze: (ctx: ReviewContext) => Promise<TriageResult> };
      correctnessAgent: {
        reviewWithOptions: (
          runArg: ReviewRun,
          ctx: ReviewContext,
          options?: {
            scopePaths?: string[];
            allowTools?: boolean;
            maxIterations?: number;
            mode?: 'skip' | 'light' | 'full';
            maxContextTokens?: number;
          }
        ) => Promise<{
          agentName: string;
          findings: Array<Omit<Finding, 'id' | 'runId' | 'published'>>;
        }>;
      };
      publishSummary: (runArg: ReviewRun, summary: string, gatedCount: number) => Promise<void>;
      publishLineComments: (
        runArg: ReviewRun,
        comments: Array<{ path: string; line: number; comment: string }>
      ) => Promise<boolean>;
    };

    internal.triageAgent = {
      analyze: mock(
        async (): Promise<TriageResult> => ({
          complexity: 'standard',
          reviewSize: 'small',
          mode: 'full',
          riskTags: ['security-sensitive'],
          rationale: 'auth file changed',
          tasks: [
            {
              domain: 'correctness',
              paths: ['src/core.ts'],
              riskTags: ['security-sensitive'],
              mode: 'full',
              tokenBudget: 12000,
              maxIterations: 2,
              allowTools: false,
              allowReflection: false,
              allowDebate: false,
            },
          ],
        })
      ),
    };

    const correctnessSpy = mock(
      async (
        _runArg: ReviewRun,
        _ctx: ReviewContext,
        _options?: {
          scopePaths?: string[];
          allowTools?: boolean;
          maxIterations?: number;
          mode?: 'skip' | 'light' | 'full';
          maxContextTokens?: number;
        }
      ) => ({
        agentName: 'Correctness Agent',
        findings: [
          {
            fingerprint: 'stage-full-fp-1',
            category: 'correctness' as const,
            severity: 'high' as const,
            confidence: 0.95,
            path: 'src/core.ts',
            line: 1,
            title: 'critical issue',
            detail: 'detail',
            evidence: 'evidence',
            suggestion: 'fix',
          },
        ],
      })
    );
    internal.correctnessAgent.reviewWithOptions = correctnessSpy;
    internal.publishSummary = mock(async () => undefined);
    internal.publishLineComments = mock(async () => true);

    await orchestrator.execute(acquired!);

    expect(correctnessSpy).toHaveBeenCalledTimes(1);
    const callArgs = correctnessSpy.mock.calls[0];
    const options = callArgs?.[2];
    expect(options?.scopePaths).toEqual(['src/core.ts']);
    expect(options?.allowTools).toBe(false);
    expect(options?.maxIterations).toBe(2);
    expect(options?.mode).toBe('full');

    const details = await store.getRunDetails(run.id);
    expect(details).not.toBeNull();
    expect(details!.findings).toHaveLength(1);
    expect(details!.findings[0].published).toBe(true);
    expect(details!.findings[0].path).toBe('src/core.ts');
  });
});
