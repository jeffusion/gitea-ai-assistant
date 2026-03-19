import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { CodexRunner } from '../codex/codex-runner';
import type { DiffExtractor } from '../context/diff-extractor';
import type { LocalRepoManager, LocalRepoPaths } from '../context/local-repo-manager';
import { ReviewOrchestrator } from '../orchestrator';
import type { FileReviewStore } from '../store/file-review-store';
import type { Finding, ReviewContext, ReviewRun, ReviewTask } from '../types';

type Snapshot = { baseSha: string; headSha: string } | null;

function makeRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'run-1',
    idempotencyKey: 'owner/repo#1:base...head',
    eventType: 'pull_request',
    status: 'in_progress',
    owner: 'owner',
    repo: 'repo',
    cloneUrl: 'https://example.com/repo.git',
    prNumber: 1,
    baseSha: 'base-sha',
    headSha: 'head-sha',
    attempts: 1,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createStoreMock() {
  const store = {
    markRunIgnored: mock(async () => undefined),
    addStep: mock(async () => undefined),
    getRunDetails: mock(async () => ({ comments: [], findings: [] })),
    addFindings: mock(async () => undefined),
    markFindingPublished: mock(async () => true),
    addCommentRecord: mock(async () => undefined),
  };
  return store;
}

function createLocalRepoManagerMock(snapshot: Snapshot) {
  const repoPaths: LocalRepoPaths = {
    mirrorPath: '/tmp/mirror',
    workspacePath: '/tmp/workspace',
  };

  const manager = {
    prepareWorkspace: mock(async () => repoPaths),
    resolveReviewedRef: mock(async () => snapshot),
    saveReviewedRef: mock(async () => undefined),
    cleanupWorkspace: mock(async () => undefined),
  };

  return { manager, repoPaths };
}

function createDiffExtractorMock(diff = 'diff --git a/a.ts b/a.ts\n+const x = 1;') {
  const context: ReviewContext = {
    workspacePath: '/tmp/workspace',
    mirrorPath: '/tmp/mirror',
    diff,
    changedFiles: [],
    parsedDiff: [],
    fileContents: {},
  };

  const extractor = {
    getSandbox: mock(() => ({
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    })),
    buildContext: mock(async () => context),
  };

  return { extractor, context };
}

function wireOrchestratorFastPath(orchestrator: ReviewOrchestrator) {
  const internal = orchestrator as unknown as {
    triageAgent: {
      analyze: (context: ReviewContext) => Promise<{
        complexity: 'trivial' | 'standard' | 'complex';
        reviewSize: 'small' | 'medium' | 'large';
        mode: 'skip' | 'light' | 'full';
        tasks: ReviewTask[];
        riskTags: string[];
        rationale: string;
      }>;
    };
    judgeAgent: {
      judge: (findings: Array<Omit<Finding, 'id' | 'runId' | 'published'>>) => {
        summaryMarkdown: string;
        findings: Array<Omit<Finding, 'id' | 'runId' | 'published'>>;
      };
    };
    publishSummary: (run: ReviewRun, summary: string, gatedCount: number) => Promise<void>;
    publishLineComments: (
      run: ReviewRun,
      comments: Array<{ path: string; line: number; comment: string }>
    ) => Promise<boolean>;
  };

  internal.triageAgent = {
    analyze: mock(async () => ({
      complexity: 'trivial' as const,
      reviewSize: 'small' as const,
      mode: 'skip' as const,
      tasks: [],
      riskTags: [],
      rationale: 'test fast-path',
    })),
  };

  internal.judgeAgent = {
    judge: mock(() => ({ summaryMarkdown: 'ok', findings: [] })),
  };

  internal.publishSummary = mock(async () => undefined);
  internal.publishLineComments = mock(async () => false);
}

function createCodexRunnerForExecute(snapshot: Snapshot) {
  const store = createStoreMock();
  const { manager, repoPaths } = createLocalRepoManagerMock(snapshot);
  const runner = new CodexRunner(
    store as unknown as FileReviewStore,
    manager as unknown as LocalRepoManager
  );

  const internal = runner as unknown as {
    generateCodexWorkspaceConfig: (workspacePath: string, runId: string) => Promise<void>;
    runCodexProcess: (
      workspacePath: string,
      run: ReviewRun,
      lastReviewedHead?: string
    ) => Promise<void>;
  };

  internal.generateCodexWorkspaceConfig = mock(async () => undefined);
  internal.runCodexProcess = mock(async () => undefined);

  return {
    runner,
    store,
    manager,
    repoPaths,
    runCodexProcessMock: internal.runCodexProcess as ReturnType<typeof mock>,
  };
}

describe('ReviewOrchestrator incremental baseline resolution', () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  test('matching baseSha uses snapshot head as lastReviewedHead', async () => {
    const run = makeRun({ baseSha: 'same-base', headSha: 'new-head' });
    const store = createStoreMock();
    const { manager } = createLocalRepoManagerMock({ baseSha: 'same-base', headSha: 'old-head' });
    const { extractor } = createDiffExtractorMock();

    const orchestrator = new ReviewOrchestrator(
      store as unknown as FileReviewStore,
      manager as unknown as LocalRepoManager,
      extractor as unknown as DiffExtractor
    );
    wireOrchestratorFastPath(orchestrator);

    await orchestrator.execute(run);

    expect(manager.resolveReviewedRef).toHaveBeenCalledTimes(1);
    expect(extractor.buildContext).toHaveBeenCalledTimes(1);
    expect(extractor.buildContext).toHaveBeenCalledWith(
      run,
      '/tmp/mirror',
      '/tmp/workspace',
      'old-head'
    );
  });

  test('different baseSha falls back to full review (no lastReviewedHead)', async () => {
    const run = makeRun({ baseSha: 'current-base' });
    const store = createStoreMock();
    const { manager } = createLocalRepoManagerMock({ baseSha: 'saved-base', headSha: 'old-head' });
    const { extractor } = createDiffExtractorMock();

    const orchestrator = new ReviewOrchestrator(
      store as unknown as FileReviewStore,
      manager as unknown as LocalRepoManager,
      extractor as unknown as DiffExtractor
    );
    wireOrchestratorFastPath(orchestrator);

    await orchestrator.execute(run);

    expect(extractor.buildContext).toHaveBeenCalledWith(
      run,
      '/tmp/mirror',
      '/tmp/workspace',
      undefined
    );
  });

  test('missing snapshot falls back to full review', async () => {
    const run = makeRun();
    const store = createStoreMock();
    const { manager } = createLocalRepoManagerMock(null);
    const { extractor } = createDiffExtractorMock();

    const orchestrator = new ReviewOrchestrator(
      store as unknown as FileReviewStore,
      manager as unknown as LocalRepoManager,
      extractor as unknown as DiffExtractor
    );
    wireOrchestratorFastPath(orchestrator);

    await orchestrator.execute(run);

    expect(extractor.buildContext).toHaveBeenCalledWith(
      run,
      '/tmp/mirror',
      '/tmp/workspace',
      undefined
    );
  });

  test('non pull_request event skips incremental snapshot lookup', async () => {
    const run = makeRun({
      eventType: 'commit_status',
      prNumber: undefined,
      commitSha: 'commit-sha',
      headSha: undefined,
    });
    const store = createStoreMock();
    const { manager } = createLocalRepoManagerMock({ baseSha: 'same-base', headSha: 'old-head' });
    const { extractor } = createDiffExtractorMock();

    const orchestrator = new ReviewOrchestrator(
      store as unknown as FileReviewStore,
      manager as unknown as LocalRepoManager,
      extractor as unknown as DiffExtractor
    );
    wireOrchestratorFastPath(orchestrator);

    await orchestrator.execute(run);

    expect(manager.resolveReviewedRef).not.toHaveBeenCalled();
    expect(extractor.buildContext).toHaveBeenCalledWith(
      run,
      '/tmp/mirror',
      '/tmp/workspace',
      undefined
    );
  });

  test('successful review saves reviewed ref snapshot', async () => {
    const run = makeRun({ baseSha: 'base-1', headSha: 'head-1', prNumber: 99 });
    const store = createStoreMock();
    const { manager } = createLocalRepoManagerMock(null);
    const { extractor } = createDiffExtractorMock();

    const orchestrator = new ReviewOrchestrator(
      store as unknown as FileReviewStore,
      manager as unknown as LocalRepoManager,
      extractor as unknown as DiffExtractor
    );
    wireOrchestratorFastPath(orchestrator);

    await orchestrator.execute(run);

    expect(manager.saveReviewedRef).toHaveBeenCalledTimes(1);
    expect(manager.saveReviewedRef).toHaveBeenCalledWith('/tmp/mirror', 99, 'base-1', 'head-1');
  });

  test('failed review does not save reviewed ref snapshot', async () => {
    const run = makeRun({ baseSha: 'base-1', headSha: 'head-1', prNumber: 99 });
    const store = createStoreMock();
    const { manager } = createLocalRepoManagerMock(null);
    const { extractor } = createDiffExtractorMock();
    extractor.buildContext = mock(async () => {
      throw new Error('context failed');
    });

    const orchestrator = new ReviewOrchestrator(
      store as unknown as FileReviewStore,
      manager as unknown as LocalRepoManager,
      extractor as unknown as DiffExtractor
    );

    let caught: Error | undefined;
    try {
      await orchestrator.execute(run);
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain('context failed');
    expect(manager.saveReviewedRef).not.toHaveBeenCalled();
  });
});

describe('CodexRunner incremental baseline resolution and prompt behavior', () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  test('matching baseSha uses snapshot head for incremental run', async () => {
    const run = makeRun({ baseSha: 'same-base', headSha: 'new-head' });
    const { runner, runCodexProcessMock } = createCodexRunnerForExecute({
      baseSha: 'same-base',
      headSha: 'old-head',
    });

    await runner.execute(run);

    expect(runCodexProcessMock).toHaveBeenCalledWith('/tmp/workspace', run, 'old-head');
  });

  test('different baseSha falls back to full run', async () => {
    const run = makeRun({ baseSha: 'current-base', headSha: 'new-head' });
    const { runner, runCodexProcessMock } = createCodexRunnerForExecute({
      baseSha: 'saved-base',
      headSha: 'old-head',
    });

    await runner.execute(run);

    expect(runCodexProcessMock).toHaveBeenCalledWith('/tmp/workspace', run, undefined);
  });

  test('missing snapshot falls back to full run', async () => {
    const run = makeRun();
    const { runner, runCodexProcessMock } = createCodexRunnerForExecute(null);

    await runner.execute(run);

    expect(runCodexProcessMock).toHaveBeenCalledWith('/tmp/workspace', run, undefined);
  });

  test('non pull_request event skips incremental snapshot lookup', async () => {
    const run = makeRun({
      eventType: 'commit_status',
      prNumber: undefined,
      commitSha: 'commit-sha',
      headSha: undefined,
    });
    const { runner, manager, runCodexProcessMock } = createCodexRunnerForExecute({
      baseSha: 'saved-base',
      headSha: 'old-head',
    });

    await runner.execute(run);

    expect(manager.resolveReviewedRef).not.toHaveBeenCalled();
    expect(runCodexProcessMock).toHaveBeenCalledWith('/tmp/workspace', run, undefined);
  });

  test('successful codex review saves reviewed ref snapshot', async () => {
    const run = makeRun({ baseSha: 'base-1', headSha: 'head-1', prNumber: 22 });
    const { runner, manager } = createCodexRunnerForExecute(null);

    await runner.execute(run);

    expect(manager.saveReviewedRef).toHaveBeenCalledTimes(1);
    expect(manager.saveReviewedRef).toHaveBeenCalledWith('/tmp/mirror', 22, 'base-1', 'head-1');
  });

  test('failed codex review does not save reviewed ref snapshot', async () => {
    const run = makeRun({ baseSha: 'base-1', headSha: 'head-1', prNumber: 22 });
    const { runner, manager } = createCodexRunnerForExecute(null);

    const internal = runner as unknown as {
      runCodexProcess: (
        workspacePath: string,
        runArg: ReviewRun,
        lastReviewedHead?: string
      ) => Promise<void>;
    };
    internal.runCodexProcess = mock(async () => {
      throw new Error('codex failed');
    });

    let caught: Error | undefined;
    try {
      await runner.execute(run);
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain('codex failed');
    expect(manager.saveReviewedRef).not.toHaveBeenCalled();
  });

  test('buildReviewPrompt includes incremental instructions when lastReviewedHead is set', () => {
    const run = makeRun({ baseSha: 'base-a', headSha: 'head-b', prNumber: 7 });
    const { runner } = createCodexRunnerForExecute(null);
    const internal = runner as unknown as {
      buildReviewPrompt: (runArg: ReviewRun, lastReviewedHead?: string) => string;
    };

    const prompt = internal.buildReviewPrompt(run, 'reviewed-head-123');

    expect(prompt).toContain('增量审查模式：仅审查上次审查后的新变更');
    expect(prompt).toContain('上次审查 SHA：reviewed-head-123');
    expect(prompt).toContain('git diff reviewed-head-123..head-b');
  });

  test('normalizeApiBaseUrl appends /v1 when missing', () => {
    const { runner } = createCodexRunnerForExecute(null);
    const internal = runner as unknown as {
      normalizeApiBaseUrl: (rawUrl: string) => string;
    };

    expect(internal.normalizeApiBaseUrl('https://api.example.com')).toBe(
      'https://api.example.com/v1'
    );
    expect(internal.normalizeApiBaseUrl('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1'
    );
    expect(internal.normalizeApiBaseUrl('https://api.example.com/')).toBe(
      'https://api.example.com/v1'
    );
  });
});
