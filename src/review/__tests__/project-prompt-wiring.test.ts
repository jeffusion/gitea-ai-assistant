import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { DiffExtractor } from '../context/diff-extractor';
import type { LocalRepoManager, LocalRepoPaths } from '../context/local-repo-manager';
import type { FileReviewStore } from '../store/file-review-store';
import type { Finding, ReviewContext, ReviewRun, ReviewTask } from '../types';

function makeRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'run-project-prompt',
    idempotencyKey: 'owner/repo#8:base...head',
    eventType: 'pull_request',
    status: 'in_progress',
    owner: 'owner',
    repo: 'repo',
    cloneUrl: 'https://example.com/repo.git',
    prNumber: 8,
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
  return {
    markRunIgnored: mock(async () => undefined),
    addStep: mock(async () => undefined),
    getRunDetails: mock(async () => ({ comments: [], findings: [] })),
    addFindings: mock(async () => undefined),
    markFindingPublished: mock(async () => true),
    addCommentRecord: mock(async () => undefined),
  };
}

function createLocalRepoManagerMock() {
  const repoPaths: LocalRepoPaths = {
    mirrorPath: '/tmp/mirror',
    workspacePath: '/tmp/workspace',
  };

  return {
    manager: {
      prepareWorkspace: mock(async () => repoPaths),
      resolveReviewedRef: mock(async () => null),
      saveReviewedRef: mock(async () => undefined),
      cleanupWorkspace: mock(async () => undefined),
    },
    repoPaths,
  };
}

function createDiffExtractorMock() {
  const context: ReviewContext = {
    workspacePath: '/tmp/workspace',
    mirrorPath: '/tmp/mirror',
    diff: 'diff --git a/src/app.ts b/src/app.ts\n+const x = 1;',
    changedFiles: [
      {
        path: 'src/app.ts',
        status: 'M',
        additions: 3,
        deletions: 1,
      },
    ],
    parsedDiff: [],
    fileContents: {},
  };

  return {
    context,
    extractor: {
      getSandbox: mock(() => ({
        execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      })),
      buildContext: mock(async () => context),
    },
  };
}

describe('project prompt wiring', () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  test('orchestrator forwards resolved project prompt to triage and specialist execution options', async () => {
    const projectPrompt = `repo-policy-${'P'.repeat(360)}`;

    mock.module('../project-review-prompt', () => ({
      resolveProjectReviewPrompt: () => projectPrompt,
    }));

    const { ReviewOrchestrator } = await import('../orchestrator');

    const store = createStoreMock();
    const { manager } = createLocalRepoManagerMock();
    const { extractor } = createDiffExtractorMock();

    const orchestrator = new ReviewOrchestrator(
      store as unknown as FileReviewStore,
      manager as unknown as LocalRepoManager,
      extractor as unknown as DiffExtractor
    );

    type TriageResultLike = {
      complexity: 'trivial' | 'standard' | 'complex';
      reviewSize: 'small' | 'medium' | 'large';
      mode: 'skip' | 'light' | 'full';
      tasks: ReviewTask[];
      riskTags: string[];
      rationale: string;
    };

    type ReviewFinding = Array<Omit<Finding, 'id' | 'runId' | 'published'>>;

    type InternalOrchestrator = {
      triageAgent: {
        analyze: (
          context: ReviewContext,
          options?: { projectPrompt?: string }
        ) => Promise<TriageResultLike>;
      };
      agentMap: Record<
        string,
        {
          reviewWithOptions: (
            run: ReviewRun,
            context: ReviewContext,
            options: { projectPrompt?: string }
          ) => Promise<{ findings: ReviewFinding }>;
          reviewWithReflection: (
            run: ReviewRun,
            context: ReviewContext,
            maxRounds?: number,
            options?: { projectPrompt?: string }
          ) => Promise<{ findings: ReviewFinding }>;
        }
      >;
      judgeAgent: {
        judge: (findings: ReviewFinding) => { summaryMarkdown: string; findings: ReviewFinding };
      };
      publishSummary: (run: ReviewRun, summary: string, gatedCount: number) => Promise<void>;
      publishLineComments: (
        run: ReviewRun,
        comments: Array<{ path: string; line: number; comment: string }>
      ) => Promise<boolean>;
    };

    const internal = orchestrator as unknown as InternalOrchestrator;

    const task: ReviewTask = {
      domain: 'correctness',
      paths: ['src/app.ts'],
      riskTags: [],
      mode: 'light',
      tokenBudget: 1200,
      maxIterations: 1,
      allowTools: false,
      allowReflection: false,
      allowDebate: false,
    };

    const triageAnalyzeMock = mock(async () => ({
      complexity: 'standard' as const,
      reviewSize: 'small' as const,
      mode: 'light' as const,
      tasks: [task],
      riskTags: [],
      rationale: 'project prompt wiring test',
    }));

    const reviewWithOptionsMock = mock(async () => ({
      findings: [] as ReviewFinding,
    }));

    const reviewWithReflectionMock = mock(async () => ({
      findings: [] as ReviewFinding,
    }));

    internal.triageAgent = {
      analyze: triageAnalyzeMock,
    };

    internal.agentMap = {
      correctness: {
        reviewWithOptions: reviewWithOptionsMock,
        reviewWithReflection: reviewWithReflectionMock,
      },
    };

    internal.judgeAgent = {
      judge: mock(() => ({
        summaryMarkdown: 'ok',
        findings: [] as ReviewFinding,
      })),
    };

    internal.publishSummary = mock(async () => undefined);
    internal.publishLineComments = mock(async () => false);

    const run = makeRun();
    await orchestrator.execute(run);

    expect(triageAnalyzeMock).toHaveBeenCalledWith(expect.anything(), { projectPrompt });
    expect(reviewWithOptionsMock).toHaveBeenCalledWith(
      run,
      expect.anything(),
      expect.objectContaining({ projectPrompt })
    );
  });

  test('codex prompt builder includes resolved project-level prompt section', async () => {
    const projectPrompt = `codex-policy-${'X'.repeat(320)}`;

    mock.module('../project-review-prompt', () => ({
      resolveProjectReviewPrompt: () => projectPrompt,
    }));

    const { CodexRunner } = await import('../codex/codex-runner');

    const store = createStoreMock();
    const { manager } = createLocalRepoManagerMock();

    const runner = new CodexRunner(
      store as unknown as FileReviewStore,
      manager as unknown as LocalRepoManager
    );

    const internal = runner as unknown as {
      buildReviewPrompt: (run: ReviewRun, lastReviewedHead?: string) => string;
    };

    const prompt = internal.buildReviewPrompt(makeRun(), undefined);

    expect(prompt).toContain('## 项目级审查要求');
    expect(prompt).toContain(projectPrompt);
  });
});
