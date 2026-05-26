import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { LocalRepoManager, LocalRepoPaths } from '../context/local-repo-manager';
import type { FileReviewStore } from '../store/file-review-store';
import type { ReviewRun } from '../types';

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
  };
}

describe('project prompt wiring', () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
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
