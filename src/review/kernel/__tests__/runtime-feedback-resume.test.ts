import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { kernelSessionRepository } from '../../../agent-kernel/session/session-repository';
import type { KernelSessionEventRecord, KernelTask } from '../../../agent-kernel/types';
import { initializeFeedbackSystem } from '../../../controllers/feedback';
import { closeDatabase, initDatabase } from '../../../db/database';
import { llmGateway } from '../../../llm/gateway';
import type { LLMChatRequest, LLMChatResponse, ModelRole } from '../../../llm/types';
import { giteaService } from '../../../services/gitea';
import { FileReviewStore } from '../../store/file-review-store';
import type { PullRequestReviewPayload, ReviewContext, ReviewRun } from '../../types';
import { kernelReviewEngine } from '../kernel-review-engine';
import { ReviewKernelRuntime } from '../review-kernel-runtime';
import { REVIEW_TRIAGE_SUBAGENT, getReviewDomainSubagentId } from '../review-subagent-ids';
import { getReviewSessionScope } from '../session-scope';

function createPullRequestPayload(keySuffix: string): PullRequestReviewPayload {
  return {
    idempotencyKey: `pr:acme/repo:301:${keySuffix}`,
    eventType: 'pull_request',
    owner: 'acme',
    repo: 'repo',
    cloneUrl: 'https://example.com/acme/repo.git',
    prNumber: 301,
    baseSha: 'base-sha',
    headSha: 'head-sha',
    maxAttempts: 2,
  };
}

function createResumeContext(workspacePath: string, mirrorPath: string): ReviewContext {
  return {
    workspacePath,
    mirrorPath,
    diff: [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,2 +1,3 @@',
      ' export function checkFlag(input?: string) {',
      '+  return input.trim() === "on" ? input.length : 0;',
      ' }',
    ].join('\n'),
    changedFiles: [{ path: 'src/index.ts', status: 'M', additions: 1, deletions: 1 }],
    parsedDiff: [
      {
        path: 'src/index.ts',
        changes: [
          {
            lineNumber: 1,
            oldLineNumber: 1,
            content: 'export function checkFlag(input?: string) {',
            type: 'context',
          },
          {
            lineNumber: 2,
            content: '  return input.trim() === "on" ? input.length : 0;',
            type: 'add',
          },
          { lineNumber: 3, oldLineNumber: 2, content: '}', type: 'context' },
        ],
      },
    ],
    fileContents: {
      'src/index.ts':
        'export function checkFlag(input?: string) {\n  return input.trim() === "on" ? input.length : 0;\n}',
    },
  };
}

function createJsonResponse(content: Record<string, unknown>): LLMChatResponse {
  return {
    content: JSON.stringify(content),
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function getTaskEvents(sessionId: string, eventType: 'task_started' | 'task_completed') {
  return kernelSessionRepository
    .listEvents(sessionId)
    .filter((event) => event.eventType === eventType)
    .map((event) => String(event.payload.name));
}

function getRelevantEvents(sessionId: string): KernelSessionEventRecord[] {
  return kernelSessionRepository
    .listEvents(sessionId)
    .filter((event) =>
      [
        'human_feedback_processed',
        'session_continue_requested',
        'session_continue_completed',
      ].includes(event.eventType)
    );
}

function countEventTypes(events: KernelSessionEventRecord[]) {
  return events.reduce<Record<string, number>>((counts, event) => {
    counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
    return counts;
  }, {});
}

function getPendingPublishTask(checkpoint: { pendingTasks: KernelTask[] } | null) {
  return checkpoint?.pendingTasks.find((task) => task.name === 'publish_review');
}

describe('ReviewKernelRuntime feedback resume', () => {
  let tempDir: string;
  let savedDbPath: string | undefined;
  let store: FileReviewStore;
  let chatCalls: Array<{ role: ModelRole; request: Omit<LLMChatRequest, 'model'> }>;
  let summaryBodies: string[];
  let lineCommentCalls: Array<{
    owner: string;
    repo: string;
    prNumber: number;
    commitId: string;
    comments: Array<{ path: string; line: number; comment: string }>;
  }>;
  let pullRequestCommentBodies: string[];
  let savedReviewedRefs: Array<{
    mirrorPath: string;
    prNumber: number;
    baseSha: string;
    targetSha: string;
  }>;
  let cleanedWorkspaces: Array<{ mirrorPath: string; workspacePath: string }>;

  const originalChatForRole = llmGateway.chatForRole;
  const originalAddPullRequestComment = giteaService.addPullRequestComment;
  const originalAddCommitComment = giteaService.addCommitComment;
  const originalAddLineComments = giteaService.addLineComments;
  const originalGetRelatedPullRequest = giteaService.getRelatedPullRequest;

  const engine = kernelReviewEngine as any;
  const originalEngineStart = engine.start;
  const originalCreateRuntime = engine.createRuntime;
  const originalStore = engine._store;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'runtime-feedback-resume-'));
    savedDbPath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = path.join(tempDir, 'assistant.db');
    initDatabase();

    store = new FileReviewStore(path.join(tempDir, 'review-workdir'));
    await store.init();
    initializeFeedbackSystem(store);

    chatCalls = [];
    summaryBodies = [];
    lineCommentCalls = [];
    pullRequestCommentBodies = [];
    savedReviewedRefs = [];
    cleanedWorkspaces = [];

    llmGateway.chatForRole = async (role, request) => {
      chatCalls.push({ role, request });

      if (role !== 'specialist') {
        throw new Error(`Unexpected LLM role: ${role}`);
      }

      return createJsonResponse({
        findings: [
          {
            fingerprint: 'publishable-finding',
            severity: 'high',
            confidence: 0.98,
            path: 'src/index.ts',
            line: 2,
            title: 'Missing optional chaining before trim',
            detail: 'input 是可选参数，直接调用 trim 会在 undefined 时抛出异常。',
            evidence: 'return input.trim() === "on" ? input.length : 0;',
            suggestion: '改为 input?.trim() === "on" ? input.length : 0。',
          },
          {
            fingerprint: 'gated-finding',
            severity: 'low',
            confidence: 0.99,
            path: 'src/index.ts',
            line: 2,
            title: 'Consider guarding string length usage',
            detail: '即使表达式能运行，低严重度建议仍应进入人工审批。',
            evidence: 'return input.trim() === "on" ? input.length : 0;',
            suggestion: '在读取 length 前统一做空值保护。',
          },
        ],
      });
    };

    giteaService.addPullRequestComment = async (_owner, _repo, _prNumber, body) => {
      if (body.includes('## AI 代码审查结果')) {
        summaryBodies.push(body);
      }
      pullRequestCommentBodies.push(body);
    };
    giteaService.addCommitComment = async () => {
      throw new Error('Commit comment should not be used in pull request resume tests');
    };
    giteaService.addLineComments = async (owner, repo, prNumber, commitId, comments) => {
      lineCommentCalls.push({ owner, repo, prNumber, commitId, comments });
    };
    giteaService.getRelatedPullRequest = async () => ({ number: 301 }) as any;
  });

  afterEach(async () => {
    llmGateway.chatForRole = originalChatForRole;
    giteaService.addPullRequestComment = originalAddPullRequestComment;
    giteaService.addCommitComment = originalAddCommitComment;
    giteaService.addLineComments = originalAddLineComments;
    giteaService.getRelatedPullRequest = originalGetRelatedPullRequest;

    engine.start = originalEngineStart;
    engine.createRuntime = originalCreateRuntime;
    engine._store = originalStore;

    closeDatabase();
    if (savedDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  test('runtime completes without human feedback after low findings are dropped', async () => {
    const { run } = await store.createOrReuseRun(createPullRequestPayload('resume-success'));
    const { scopeType, scopeKey } = getReviewSessionScope(run);
    const session = kernelSessionRepository.ensureSession({
      scopeType,
      scopeKey,
      metadata: {
        owner: run.owner,
        repo: run.repo,
        prNumber: run.prNumber,
        eventType: run.eventType,
        headSha: run.headSha,
      },
      runId: run.id,
    });

    const runtime = new ReviewKernelRuntime(
      store,
      {
        prepareWorkspace: async (
          _owner: string,
          _repo: string,
          _cloneUrl: string,
          targetSha: string,
          runId: string
        ) => ({
          mirrorPath: path.join(tempDir, 'repos', `${targetSha}-mirror.git`),
          workspacePath: path.join(tempDir, 'workspaces', runId),
        }),
        resolveReviewedRef: async () => null,
        saveReviewedRef: async (
          mirrorPath: string,
          prNumber: number,
          baseSha: string,
          targetSha: string
        ) => {
          savedReviewedRefs.push({ mirrorPath, prNumber, baseSha, targetSha });
        },
        cleanupWorkspace: async ({ mirrorPath, workspacePath }) => {
          cleanedWorkspaces.push({ mirrorPath, workspacePath });
        },
      } as any,
      {
        getSandbox: () => ({
          run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        }),
        buildContext: async (_runtimeRun: ReviewRun, mirrorPath: string, workspacePath: string) =>
          createResumeContext(workspacePath, mirrorPath),
      } as any
    );

    engine.start = async () => undefined;
    engine.createRuntime = () => runtime;
    engine._store = store;

    const firstCheckpoint = await runtime.execute(run, session.id);
    const checkpointBeforeResume = kernelSessionRepository.loadCheckpoint<any>(session.id);
    const runDetailsBeforeResume = await store.getRunDetails(run.id);
    const droppedFinding = firstCheckpoint.state.policyResult?.dropped.find(
      (finding) => finding.fingerprint === 'gated-finding'
    );

    expect(firstCheckpoint.stopReason).toBe('completed');
    expect(firstCheckpoint.pendingTasks).toEqual([]);
    expect(firstCheckpoint.state.published).toBe(true);
    expect(firstCheckpoint.state.reviewedRefSaved).toBe(true);
    expect(firstCheckpoint.state.policyResult).toMatchObject({
      publishable: [expect.objectContaining({ fingerprint: 'publishable-finding' })],
      gated: [],
      dropped: [expect.objectContaining({ fingerprint: 'gated-finding' })],
    });
    expect(checkpointBeforeResume?.stopReason).toBe('completed');
    expect(checkpointBeforeResume?.pendingTasks).toEqual([]);
    expect(getPendingPublishTask(checkpointBeforeResume)).toBeUndefined();
    expect(checkpointBeforeResume?.state).toMatchObject({
      published: true,
      reviewedRefSaved: true,
    });
    expect(
      runDetailsBeforeResume?.comments.filter((comment) => comment.status === 'pending')
    ).toHaveLength(0);
    expect(
      runDetailsBeforeResume?.comments.filter((comment) => comment.fingerprint === 'gated-finding')
    ).toHaveLength(0);
    expect(
      runDetailsBeforeResume?.comments.filter(
        (comment) => comment.fingerprint === 'publishable-finding'
      )
    ).toHaveLength(0);
    expect(droppedFinding).toBeDefined();
    expect(summaryBodies).toHaveLength(1);
    expect(lineCommentCalls).toHaveLength(1);
    expect(lineCommentCalls[0]?.comments).toHaveLength(1);
    expect(lineCommentCalls[0]?.comments[0]).toMatchObject({
      path: 'src/index.ts',
      line: 2,
    });

    const taskStartsBeforeResume = getTaskEvents(session.id, 'task_started');
    const taskCompletionsBeforeResume = getTaskEvents(session.id, 'task_completed');
    expect(taskStartsBeforeResume).toEqual(
      expect.arrayContaining([
        'prepare_workspace',
        'build_context',
        REVIEW_TRIAGE_SUBAGENT,
        getReviewDomainSubagentId('correctness'),
        'aggregate_findings',
        'publish_review',
        'save_reviewed_ref',
      ])
    );
    expect(taskCompletionsBeforeResume).toEqual(
      expect.arrayContaining([
        'prepare_workspace',
        'build_context',
        REVIEW_TRIAGE_SUBAGENT,
        getReviewDomainSubagentId('correctness'),
        'aggregate_findings',
        'publish_review',
        'save_reviewed_ref',
      ])
    );
    expect(
      runDetailsBeforeResume?.findings.find(
        (finding) => finding.fingerprint === 'publishable-finding'
      )?.published
    ).toBe(true);
    expect(
      runDetailsBeforeResume?.findings.find((finding) => finding.fingerprint === 'gated-finding')
        ?.published
    ).toBeUndefined();
    expect(pullRequestCommentBodies).toHaveLength(1);
    expect(summaryBodies).toHaveLength(1);
    expect(lineCommentCalls).toHaveLength(1);
    expect(taskStartsBeforeResume.filter((name) => name === 'publish_review')).toHaveLength(1);
    expect(taskCompletionsBeforeResume.filter((name) => name === 'publish_review')).toHaveLength(1);
    expect(taskStartsBeforeResume.filter((name) => name === 'save_reviewed_ref')).toHaveLength(1);
    expect(taskCompletionsBeforeResume.filter((name) => name === 'save_reviewed_ref')).toHaveLength(
      1
    );
    expect(savedReviewedRefs).toEqual([
      {
        mirrorPath: path.join(tempDir, 'repos', 'head-sha-mirror.git'),
        prNumber: 301,
        baseSha: 'base-sha',
        targetSha: 'head-sha',
      },
    ]);
    expect(cleanedWorkspaces).toEqual([
      {
        mirrorPath: path.join(tempDir, 'repos', 'head-sha-mirror.git'),
        workspacePath: path.join(tempDir, 'workspaces', run.id),
      },
    ]);
  });

  test('continuing an already completed session does not republish or progress tasks again', async () => {
    const { run } = await store.createOrReuseRun(createPullRequestPayload('continue-completed'));
    const { scopeType, scopeKey } = getReviewSessionScope(run);
    const session = kernelSessionRepository.ensureSession({
      scopeType,
      scopeKey,
      metadata: {
        owner: run.owner,
        repo: run.repo,
        prNumber: run.prNumber,
        eventType: run.eventType,
        headSha: run.headSha,
      },
      runId: run.id,
    });

    const runtime = new ReviewKernelRuntime(
      store,
      {
        prepareWorkspace: async (
          _owner: string,
          _repo: string,
          _cloneUrl: string,
          targetSha: string,
          runId: string
        ) => ({
          mirrorPath: path.join(tempDir, 'repos', `${targetSha}-mirror.git`),
          workspacePath: path.join(tempDir, 'workspaces', runId),
        }),
        resolveReviewedRef: async () => null,
        saveReviewedRef: async (
          mirrorPath: string,
          prNumber: number,
          baseSha: string,
          targetSha: string
        ) => {
          savedReviewedRefs.push({ mirrorPath, prNumber, baseSha, targetSha });
        },
        cleanupWorkspace: async ({ mirrorPath, workspacePath }) => {
          cleanedWorkspaces.push({ mirrorPath, workspacePath });
        },
      } as any,
      {
        getSandbox: () => ({
          run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        }),
        buildContext: async (_runtimeRun: ReviewRun, mirrorPath: string, workspacePath: string) =>
          createResumeContext(workspacePath, mirrorPath),
      } as any
    );

    engine.start = async () => undefined;
    engine.createRuntime = () => runtime;
    engine._store = store;

    await runtime.execute(run, session.id);

    const checkpointAfterFeedback = kernelSessionRepository.loadCheckpoint<any>(session.id);
    const taskStartsBeforeSecondContinue = getTaskEvents(session.id, 'task_started');
    const taskCompletionsBeforeSecondContinue = getTaskEvents(session.id, 'task_completed');
    const commentCountBeforeSecondContinue =
      (await store.getRunDetails(run.id))?.comments.length ?? 0;
    const lineCommentCallCountBeforeSecondContinue = lineCommentCalls.length;
    const pullRequestCommentCountBeforeSecondContinue = pullRequestCommentBodies.length;
    const reviewedRefSaveCountBeforeSecondContinue = savedReviewedRefs.length;
    const relevantEventsBeforeSecondContinue = getRelevantEvents(session.id);
    const relevantEventCountsBeforeSecondContinue = countEventTypes(
      relevantEventsBeforeSecondContinue
    );

    expect(checkpointAfterFeedback?.stopReason).toBe('completed');

    const continued = await kernelReviewEngine.continueSession(session.id);
    const finalCheckpoint = kernelSessionRepository.loadCheckpoint<any>(session.id);
    const finalRunDetails = await store.getRunDetails(run.id);
    const taskStartsAfterSecondContinue = getTaskEvents(session.id, 'task_started');
    const taskCompletionsAfterSecondContinue = getTaskEvents(session.id, 'task_completed');
    const relevantEventsAfterSecondContinue = getRelevantEvents(session.id);

    expect(continued).toBe(true);
    expect(finalCheckpoint?.stopReason).toBe('completed');
    expect(finalCheckpoint?.pendingTasks).toEqual([]);
    expect(finalRunDetails?.comments).toHaveLength(commentCountBeforeSecondContinue);
    expect(lineCommentCalls).toHaveLength(lineCommentCallCountBeforeSecondContinue);
    expect(pullRequestCommentBodies).toHaveLength(pullRequestCommentCountBeforeSecondContinue);
    expect(savedReviewedRefs).toHaveLength(reviewedRefSaveCountBeforeSecondContinue);
    expect(taskStartsAfterSecondContinue).toEqual(taskStartsBeforeSecondContinue);
    expect(taskCompletionsAfterSecondContinue).toEqual(taskCompletionsBeforeSecondContinue);
    const relevantEventCountsAfterSecondContinue = countEventTypes(
      relevantEventsAfterSecondContinue
    );
    expect(relevantEventsAfterSecondContinue).toHaveLength(
      relevantEventsBeforeSecondContinue.length + 2
    );
    expect(relevantEventCountsAfterSecondContinue.human_feedback_processed).toBeUndefined();
    expect(relevantEventCountsAfterSecondContinue.session_continue_requested).toBe(
      (relevantEventCountsBeforeSecondContinue.session_continue_requested ?? 0) + 1
    );
    expect(relevantEventCountsAfterSecondContinue.session_continue_completed).toBe(
      (relevantEventCountsBeforeSecondContinue.session_continue_completed ?? 0) + 1
    );
    expect(
      relevantEventsAfterSecondContinue
        .filter((event) =>
          ['session_continue_requested', 'session_continue_completed'].includes(event.eventType)
        )
        .every((event) => event.payload.runId === run.id)
    ).toBe(true);
  });
});
