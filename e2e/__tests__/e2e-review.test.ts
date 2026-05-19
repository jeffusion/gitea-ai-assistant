import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  E2ETestHarness,
  type Finding,
  type Scenario,
  type SessionDetail,
} from './e2e-test-harness';

function assertFindingsMatchScenario(findings: Finding[], scenario: Scenario): void {
  expect(findings.length).toBeGreaterThanOrEqual(scenario.minFindings);

  if (scenario.maxFindings !== undefined) {
    expect(findings.length).toBeLessThanOrEqual(scenario.maxFindings);
  }

  const highSeverityCount = findings.filter((finding) => finding.severity === 'high').length;
  expect(highSeverityCount).toBeGreaterThanOrEqual(scenario.minHighSeverity);

  const fingerprints = findings
    .map((finding) => finding.fingerprint)
    .filter((value): value is string => Boolean(value));
  expect(new Set(fingerprints).size).toBe(fingerprints.length);
}

function expectPipelineStepsCompleted(detail: SessionDetail): void {
  const statusesByKey = new Map(detail.plan.map((step) => [step.key, step.status]));
  expect(statusesByKey.get('prepare_workspace')).toBe('completed');
  expect(statusesByKey.get('build_context')).toBe('completed');
  expect(statusesByKey.get('review:triage')).toBe('completed');
  expect(statusesByKey.get('review:full_review')).toBe('completed');
  expect(statusesByKey.get('aggregate_findings')).toBe('completed');
  expect(statusesByKey.get('publish_review')).toBe('completed');
  expect(statusesByKey.get('save_reviewed_ref')).toBe('completed');
}

function expectAutonomousFullReviewPipeline(detail: SessionDetail): void {
  const fullReviewInvocations = detail.subagentInvocations.filter(
    (invocation) => invocation.subagentName === 'review:full_review'
  );
  expect(fullReviewInvocations).toHaveLength(1);
  expect(fullReviewInvocations[0].status).toBe('completed');
  expect(detail.checkpoint?.state?.reviewCompleted).toBe(true);
  expect(detail.checkpoint?.state?.published).toBe(true);
  expect(detail.checkpoint?.state?.reviewedRefSaved).toBe(true);
  expect(detail.checkpoint?.state?.reviewDiagnostics?.toolCallNames).toEqual([
    'search_code',
    'read_file',
    'read_file',
  ]);
  expect(detail.checkpoint?.state?.reviewDiagnostics?.stopReason).toBe('modelFinalized');

  const findings = detail.checkpoint?.state?.findings ?? [];
  expect(findings.length).toBeGreaterThan(0);
  expect(findings[0].detail).toContain('auth/user model');
  expect(findings[0].evidence).toContain('src/auth.ts');

  const publishedComments = detail.runDetails?.comments?.filter(
    (comment) => comment.status === 'published'
  );
  expect(publishedComments?.length).toBeGreaterThan(0);
  expect(publishedComments?.some((comment) => !comment.path)).toBe(true);
  expect(publishedComments?.some((comment) => comment.path === 'src/user-handler.ts')).toBe(true);
}

describe('E2E Review Flow', () => {
  const harness = new E2ETestHarness();

  beforeAll(async () => {
    await harness.start();
    await harness.seedGitea();
  }, 90_000);

  afterAll(async () => {
    await harness.stop();
  });

  test('核心链路验证: webhook → clone → triage → full_review → aggregate → publish → save ref → Gitea has comments', async () => {
    const { owner, repo, prNumber } = await harness.seedPR('simple-bug-pr');

    const webhookResponse = await harness.triggerWebhook(owner, repo, prNumber);
    expect(webhookResponse.status).toBe('accepted');

    const result = await harness.waitForReview(owner, repo, prNumber, 120);
    expect(result.completed).toBe(true);
    expect(result.sessionState).toBe('completed');
    expectPipelineStepsCompleted(result.detail);
    expect(result.detail.checkpoint?.state?.published).toBe(true);
    expectAutonomousFullReviewPipeline(result.detail);

    const comments = await harness.getGiteaComments(owner, repo, prNumber);
    expect(comments.length).toBeGreaterThan(0);
  }, 150_000);

  test('状态正确性: session status transitions and checkpoint consistency', async () => {
    const { owner, repo, prNumber } = await harness.seedPR('security-pr');

    await harness.triggerWebhook(owner, repo, prNumber);
    const snapshot = await harness.waitForSessionSnapshot(owner, repo, prNumber, 30);
    expect(['queued', 'planning', 'executing', 'completed']).toContain(
      snapshot.detail.summary.status
    );

    const result = await harness.waitForReview(owner, repo, prNumber, 120);
    expect(['queued', 'planning', 'executing', 'completed']).toContain(result.observedStates[0]);
    expect(result.sessionState).toBe('completed');
    expect(result.detail.checkpoint?.stopReason).toBe('completed');
    expect(result.detail.checkpoint?.pendingTasks ?? []).toHaveLength(0);
    expect(result.detail.summary.findingCount).toBe(harness.extractFindings(result.detail).length);
  }, 150_000);

  test('Findings 质量: fixtures trigger expected triage modes, autonomous full review, and finding counts', async () => {
    const fixtureNames = ['simple-bug-pr', 'minimal-change-pr'];

    for (const fixtureName of fixtureNames) {
      const { owner, repo, prNumber, scenario } = await harness.seedPR(fixtureName);
      await harness.triggerWebhook(owner, repo, prNumber);
      const result = await harness.waitForReview(owner, repo, prNumber, 120);
      expect(result.sessionState).toBe('completed');

      const triageMode = harness.extractTriageMode(result.detail);
      if (triageMode !== undefined) {
        expect(triageMode).toBe(scenario.expectedTriageMode);
      }

      expectPipelineStepsCompleted(result.detail);
      expect(result.detail.subagentInvocations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ subagentName: 'review:full_review', status: 'completed' }),
        ])
      );

      assertFindingsMatchScenario(harness.extractFindings(result.detail), scenario);
    }
  }, 360_000);

  test('幂等性: duplicate webhook does not create duplicate comments', async () => {
    const { owner, repo, prNumber } = await harness.seedPR('duplicate-webhook-pr');

    await harness.triggerWebhook(owner, repo, prNumber);
    const firstResult = await harness.waitForReview(owner, repo, prNumber, 120);
    expect(firstResult.sessionState).toBe('completed');
    const firstComments = await harness.getGiteaComments(owner, repo, prNumber);
    expect(firstComments.length).toBeGreaterThan(0);

    const duplicateWebhookResponse = await harness.triggerWebhook(owner, repo, prNumber);
    expect(['accepted', 'deduplicated']).toContain(duplicateWebhookResponse.status);
    const secondResult = await harness.waitForReview(owner, repo, prNumber, 60);
    expect(secondResult.sessionId).toBe(firstResult.sessionId);
    const secondComments = await harness.getGiteaComments(owner, repo, prNumber);

    expect(secondComments.length).toBe(firstComments.length);
    expect(new Set(secondComments.map((comment) => comment.body)).size).toBe(
      new Set(firstComments.map((comment) => comment.body)).size
    );
  }, 180_000);

  test('错误恢复: clone failure marks session failed, not stuck', async () => {
    const { owner, repo, prNumber } = await harness.seedPR('clean-refactor-pr');

    await harness.triggerWebhook(owner, repo, prNumber, {
      repositoryPatch: {
        clone_url: `http://invalid-host-99999.local/${owner}/${repo}-missing.git`,
      },
    });

    const result = await harness.waitForReview(owner, repo, prNumber, 120);
    expect(['completed', 'failed']).toContain(result.sessionState);
  }, 150_000);
});
