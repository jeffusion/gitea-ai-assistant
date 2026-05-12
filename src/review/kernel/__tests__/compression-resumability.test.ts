import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { z } from 'zod';
import { kernelSessionRepository } from '../../../agent-kernel/session/session-repository';
import { initializeFeedbackSystem } from '../../../controllers/feedback';
import { modelRoleRepo } from '../../../db/repositories/model-role-repo';
import { llmGateway } from '../../../llm/gateway';
import { giteaService } from '../../../services/gitea';
import { SpecialistAgent } from '../../agents/specialist-agent';
import { tokenCounter } from '../../context/token-counter';
import { ToolRegistry } from '../../tools/registry';
import type { PullRequestReviewPayload, ReviewContext, ReviewRun } from '../../types';
import { kernelReviewEngine } from '../kernel-review-engine';
import { ReviewKernelRuntime } from '../review-kernel-runtime';
import type { ReviewKernelState } from '../review-kernel-state';
import { REVIEW_TRIAGE_SUBAGENT, getReviewDomainSubagentId } from '../review-subagent-ids';
import { getReviewSessionScope } from '../session-scope';
import {
  type KernelBoundaryRestorePoint,
  type KernelTestFixture,
  captureKernelBoundaryRestorePoint,
  createKernelTestFixture,
} from './kernel-test-fixtures';

function createJsonResponse(content: Record<string, unknown>) {
  return {
    content: JSON.stringify(content),
    toolCalls: [],
    finishReason: 'stop' as const,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function createStubLocalRepoManager(
  tempDir: string,
  hooks?: {
    saveReviewedRef?: (args: {
      mirrorPath: string;
      prNumber: number;
      baseSha: string;
      targetSha: string;
    }) => void | Promise<void>;
    cleanupWorkspace?: (args: {
      mirrorPath: string;
      workspacePath: string;
    }) => void | Promise<void>;
  }
) {
  return {
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
      await hooks?.saveReviewedRef?.({ mirrorPath, prNumber, baseSha, targetSha });
    },
    cleanupWorkspace: async ({
      mirrorPath,
      workspacePath,
    }: {
      mirrorPath: string;
      workspacePath: string;
    }) => {
      await hooks?.cleanupWorkspace?.({ mirrorPath, workspacePath });
    },
  };
}

function createStubDiffExtractor(
  buildContext: (
    run: ReviewRun,
    mirrorPath: string,
    workspacePath: string
  ) => Promise<ReviewContext> | ReviewContext
) {
  return {
    getSandbox: () => ({
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    buildContext,
  };
}

function createPullRequestPayload(
  keySuffix: string,
  overrides: Partial<PullRequestReviewPayload> = {}
): PullRequestReviewPayload {
  return {
    idempotencyKey: `pr:acme/repo:${overrides.prNumber ?? 801}:${keySuffix}`,
    eventType: 'pull_request',
    owner: 'acme',
    repo: 'repo',
    cloneUrl: 'https://example.com/acme/repo.git',
    prNumber: 801,
    baseSha: 'base-sha',
    headSha: `head-${keySuffix}`,
    maxAttempts: 2,
    ...overrides,
  };
}

function createReviewContext(
  size: 'small' | 'compressible',
  workspacePath: string,
  mirrorPath: string
): ReviewContext {
  if (size === 'small') {
    return {
      workspacePath,
      mirrorPath,
      diff: [
        'diff --git a/src/index.ts b/src/index.ts',
        '--- a/src/index.ts',
        '+++ b/src/index.ts',
        '@@ -1,2 +1,3 @@',
        ' export function checkFlag(input?: string) {',
        '+  return input.trim() === "on";',
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
              content: '  return input.trim() === "on";',
              type: 'add',
            },
            {
              lineNumber: 3,
              oldLineNumber: 2,
              content: '}',
              type: 'context',
            },
          ],
        },
      ],
      fileContents: {
        'src/index.ts':
          'export function checkFlag(input?: string) {\n  return input.trim() === "on";\n}',
      },
    };
  }

  const changedFiles = Array.from({ length: 4 }, (_, index) => ({
    path: `src/module-${index}.ts`,
    status: 'M' as const,
    additions: 40,
    deletions: 10,
  }));

  return {
    workspacePath,
    mirrorPath,
    diff: `diff --git a/src/module-0.ts b/src/module-0.ts\n${'x'.repeat(120_000)}`,
    changedFiles,
    parsedDiff: changedFiles.map((file, index) => ({
      path: file.path,
      changes: [
        {
          lineNumber: index + 1,
          content: `export const module${index} = input.trim();`,
          type: 'add' as const,
        },
      ],
    })),
    fileContents: Object.fromEntries(
      changedFiles.map((file, index) => [
        file.path,
        `export function module${index}(input?: string) {\n  return input.trim() === "x" ? input.length : 0;\n}\n${'y'.repeat(6000)}`,
      ])
    ),
  };
}

function createRuntime(
  fixture: KernelTestFixture,
  buildContext: (run: ReviewRun, mirrorPath: string, workspacePath: string) => ReviewContext,
  hooks?: {
    saveReviewedRef?: (args: {
      mirrorPath: string;
      prNumber: number;
      baseSha: string;
      targetSha: string;
    }) => void | Promise<void>;
    cleanupWorkspace?: (args: {
      mirrorPath: string;
      workspacePath: string;
    }) => void | Promise<void>;
  }
) {
  return new ReviewKernelRuntime(
    fixture.store,
    createStubLocalRepoManager(fixture.tempDir, hooks) as any,
    createStubDiffExtractor(async (run, mirrorPath, workspacePath) =>
      buildContext(run, mirrorPath, workspacePath)
    ) as any
  );
}

describe('compression resumability and production canaries', () => {
  let fixture: KernelTestFixture;
  let restorePoint: KernelBoundaryRestorePoint;
  let savedDbPath: string | undefined;
  let originalGetByRole: typeof modelRoleRepo.getByRole;
  let originalGetContextWindow: typeof tokenCounter.getContextWindow;

  beforeEach(async () => {
    fixture = await createKernelTestFixture('compression-resumability-');
    restorePoint = captureKernelBoundaryRestorePoint();
    savedDbPath = process.env.DATABASE_PATH;
    originalGetByRole = modelRoleRepo.getByRole;
    originalGetContextWindow = tokenCounter.getContextWindow.bind(tokenCounter);
  });

  afterEach(async () => {
    restorePoint.restore();
    modelRoleRepo.getByRole = originalGetByRole;
    tokenCounter.getContextWindow = originalGetContextWindow;
    if (savedDbPath !== undefined) {
      process.env.DATABASE_PATH = savedDbPath;
    }
    await fixture.cleanup();
  });

  test('自动压缩并持久化 summary，向 triage/specialist 注入 contextSummary 且后续执行完成', async () => {
    const compressedSummary =
      '## Change Overview\n- Compressed review context\n\n## High-Risk Areas\n- optional input handling\n\n## Important Files\n- src/module-0.ts\n\n## Open Questions\n- none\n\n## Recommended Focus\n- validate trim and length access';
    const summaryBodies: string[] = [];
    const plannerPrompts: string[] = [];
    const specialistPrompts: string[] = [];
    let plannerCallCount = 0;

    modelRoleRepo.getByRole = ((role: string) => {
      if (role === 'planner') {
        return {
          role: 'planner',
          provider_id: 'provider-1',
          model: 'gpt-4o',
          updated_at: new Date().toISOString(),
        };
      }
      return originalGetByRole(role as any);
    }) as typeof modelRoleRepo.getByRole;
    tokenCounter.getContextWindow = () => 4_000;

    llmGateway.chatForRole = async (role, request) => {
      const userMessage = String(request.messages[request.messages.length - 1]?.content ?? '');

      if (role === 'planner') {
        plannerCallCount += 1;
        if (plannerCallCount === 1) {
          return createJsonResponse({ summary: compressedSummary });
        }
        plannerPrompts.push(userMessage);
        return createJsonResponse({
          complexity: 'standard',
          review_size: 'medium',
          mode: 'light',
          relevant_domains: ['correctness'],
          risk_tags: [],
          rationale: '需要 correctness 审查',
        });
      }

      if (role === 'specialist') {
        specialistPrompts.push(userMessage);
        return createJsonResponse({
          findings: [
            {
              fingerprint: 'compression-specialist-finding',
              severity: 'high',
              confidence: 0.98,
              path: 'src/module-0.ts',
              line: 1,
              title: 'Missing optional chaining before trim',
              detail: 'input 是可选参数，直接 trim 会在 undefined 时抛错。',
              evidence: 'export const module0 = input.trim();',
              suggestion: '改为 input?.trim() 或先做空值判断。',
            },
          ],
        });
      }

      throw new Error(`Unexpected LLM role: ${role}`);
    };

    giteaService.addPullRequestComment = async (_owner, _repo, _prNumber, body) => {
      summaryBodies.push(body);
    };
    giteaService.addCommitComment = async () => {
      throw new Error('Commit comment should not be used in pull request tests');
    };
    giteaService.addLineComments = async () => undefined;
    giteaService.getRelatedPullRequest = async () => ({ number: 801 }) as any;

    const { run } = await fixture.store.createOrReuseRun(
      createPullRequestPayload('compression-complete')
    );
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

    const runtime = createRuntime(fixture, (_run, mirrorPath, workspacePath) =>
      createReviewContext('compressible', workspacePath, mirrorPath)
    );

    const checkpoint = await runtime.execute(run, session.id);
    const persistedCheckpoint = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(
      session.id
    );

    expect(checkpoint.stopReason).toBe('completed');
    expect(checkpoint.state.compressedContext).toBeDefined();
    expect(persistedCheckpoint?.state.compressedContext).toMatchObject({
      summary: compressedSummary,
      sourceTokenEstimate: expect.any(Number),
      summaryTokenEstimate: expect.any(Number),
      triggerThreshold: 3200,
      model: 'gpt-4o',
      compressedAt: expect.any(String),
    });
    expect(plannerCallCount).toBe(2);
    expect(plannerPrompts).toHaveLength(1);
    expect(plannerPrompts[0]).toContain(compressedSummary);
    expect(specialistPrompts).toHaveLength(1);
    expect(specialistPrompts[0]).toContain(compressedSummary);
    expect(summaryBodies).toHaveLength(1);
  });

  test('低于阈值时不会压缩上下文', async () => {
    let plannerCompressionCalls = 0;

    modelRoleRepo.getByRole = ((role: string) => {
      if (role === 'planner') {
        return {
          role: 'planner',
          provider_id: 'provider-1',
          model: 'gpt-4o',
          updated_at: new Date().toISOString(),
        };
      }
      return originalGetByRole(role as any);
    }) as typeof modelRoleRepo.getByRole;
    tokenCounter.getContextWindow = () => 128_000;

    llmGateway.chatForRole = async (role) => {
      if (role !== 'specialist') {
        throw new Error(`Unexpected LLM role: ${role}`);
      }
      return createJsonResponse({
        findings: [
          {
            fingerprint: 'below-threshold-finding',
            severity: 'high',
            confidence: 0.98,
            path: 'src/index.ts',
            line: 2,
            title: 'Missing optional chaining before trim',
            detail: 'input 是可选参数，直接 trim 会在 undefined 时抛错。',
            evidence: 'return input.trim() === "on";',
            suggestion: '改为 input?.trim() === "on"。',
          },
        ],
      });
    };

    giteaService.addPullRequestComment = async () => undefined;
    giteaService.addCommitComment = async () => {
      throw new Error('Commit comment should not be used in pull request tests');
    };
    giteaService.addLineComments = async () => undefined;
    giteaService.getRelatedPullRequest = async () => ({ number: 801 }) as any;

    const runtime = createRuntime(fixture, (_run, mirrorPath, workspacePath) => {
      plannerCompressionCalls += 1;
      return createReviewContext('small', workspacePath, mirrorPath);
    });

    const { run } = await fixture.store.createOrReuseRun(
      createPullRequestPayload('below-threshold')
    );
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

    const checkpoint = await runtime.execute(run, session.id);

    expect(checkpoint.stopReason).toBe('completed');
    expect(checkpoint.state.compressedContext).toBeUndefined();
    expect(plannerCompressionCalls).toBe(1);
  });

  describe('production canary suite', () => {
    test('happy path canary completes end-to-end with published output', async () => {
      const summaryBodies: string[] = [];
      const lineCommentCalls: Array<Array<{ path: string; line: number; comment: string }>> = [];

      llmGateway.chatForRole = async (role) => {
        if (role !== 'specialist') {
          throw new Error(`Unexpected LLM role: ${role}`);
        }
        return createJsonResponse({
          findings: [
            {
              fingerprint: 'happy-path-finding',
              severity: 'high',
              confidence: 0.98,
              path: 'src/index.ts',
              line: 2,
              title: 'Missing optional chaining before trim',
              detail: 'input 是可选参数，直接 trim 会在 undefined 时抛错。',
              evidence: 'return input.trim() === "on";',
              suggestion: '改为 input?.trim() === "on"。',
            },
          ],
        });
      };

      giteaService.addPullRequestComment = async (_owner, _repo, _prNumber, body) => {
        summaryBodies.push(body);
      };
      giteaService.addCommitComment = async () => {
        throw new Error('Commit comment should not be used in pull request tests');
      };
      giteaService.addLineComments = async (_owner, _repo, _prNumber, _commitId, comments) => {
        lineCommentCalls.push(comments);
      };
      giteaService.getRelatedPullRequest = async () => ({ number: 801 }) as any;

      const { run } = await fixture.store.createOrReuseRun(
        createPullRequestPayload('canary-happy')
      );
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

      const checkpoint = await createRuntime(fixture, (_run, mirrorPath, workspacePath) =>
        createReviewContext('small', workspacePath, mirrorPath)
      ).execute(run, session.id);

      expect(checkpoint.stopReason).toBe('completed');
      expect(checkpoint.state.published).toBe(true);
      expect(checkpoint.state.reviewedRefSaved).toBe(true);
      expect(summaryBodies).toHaveLength(1);
      expect(lineCommentCalls).toHaveLength(1);
      expect(lineCommentCalls[0]?.[0]).toMatchObject({ path: 'src/index.ts', line: 2 });
    });

    test('permission deny canary keeps specialist chain recoverable', async () => {
      let deniedToolExecuted = false;
      const toolRegistry = new ToolRegistry();
      toolRegistry.register({
        name: 'network_lookup',
        description: 'network tool for canary',
        parameters: z.object({ query: z.string() }),
        permissionScope: 'network',
        execute: async () => {
          deniedToolExecuted = true;
          return { ok: true };
        },
      });

      let callCount = 0;
      const specialist = new SpecialistAgent(
        llmGateway as any,
        'correctness',
        'Permission Canary Specialist',
        'optional input handling',
        toolRegistry
      );

      llmGateway.chatForRole = async (_role, request) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: 'need tool',
            toolCalls: [
              {
                id: 'tool-1',
                name: 'network_lookup',
                arguments: JSON.stringify({ query: 'trim usage' }),
              },
            ],
            finishReason: 'tool_calls',
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          };
        }

        const toolResultMessage = request.messages[request.messages.length - 1];
        expect(toolResultMessage?.role).toBe('tool');
        expect(String(toolResultMessage?.content ?? '')).toContain('denied');

        return createJsonResponse({
          findings: [
            {
              fingerprint: 'permission-denied-finding',
              severity: 'medium',
              confidence: 0.95,
              path: 'src/index.ts',
              line: 2,
              title: 'Fallback after permission deny still reports issue',
              detail: '工具拒绝后仍可基于已有上下文输出稳定 finding。',
              evidence: 'return input.trim() === "on";',
              suggestion: '继续使用无工具模式审查。',
            },
          ],
          need_more_investigation: false,
        });
      };

      const result = await specialist.reviewWithOptions(
        {
          id: 'permission-deny-run',
          owner: 'acme',
          repo: 'repo',
          cloneUrl: 'https://example.com/acme/repo.git',
          eventType: 'pull_request',
          prNumber: 801,
          baseSha: 'base-sha',
          headSha: 'head-permission-deny',
          status: 'in_progress',
          attempts: 0,
          maxAttempts: 2,
          idempotencyKey: 'permission-deny-run',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as ReviewRun,
        createReviewContext('small', '/tmp/workspace', '/tmp/mirror.git'),
        { allowTools: true, mode: 'full', maxIterations: 2 }
      );

      expect(deniedToolExecuted).toBe(false);
      expect(callCount).toBe(2);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({ fingerprint: 'permission-denied-finding' });
    });

    test('feedback resume canary completes pending reviewed ref save once', async () => {
      initializeFeedbackSystem(fixture.store);
      const pullRequestCommentBodies: string[] = [];
      const saveReviewedRefCalls: Array<{
        mirrorPath: string;
        prNumber: number;
        baseSha: string;
        targetSha: string;
      }> = [];

      llmGateway.chatForRole = async (role) => {
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
              detail: '发布型 finding。',
              evidence: 'return input.trim() === "on";',
              suggestion: '改为 input?.trim() === "on"。',
            },
            {
              fingerprint: 'gated-finding',
              severity: 'low',
              confidence: 0.99,
              path: 'src/index.ts',
              line: 2,
              title: 'Need human review',
              detail: '低严重度建议进入人工审批。',
              evidence: 'return input.trim() === "on";',
              suggestion: '统一做空值保护。',
            },
          ],
        });
      };

      giteaService.addPullRequestComment = async (_owner, _repo, _prNumber, body) => {
        pullRequestCommentBodies.push(body);
      };
      giteaService.addCommitComment = async () => {
        throw new Error('Commit comment should not be used in pull request tests');
      };
      giteaService.addLineComments = async () => undefined;
      giteaService.getRelatedPullRequest = async () => ({ number: 801 }) as any;

      const engine = kernelReviewEngine as any;
      engine.start = async () => undefined;
      engine._store = fixture.store;

      const runtime = createRuntime(
        fixture,
        (_run, mirrorPath, workspacePath) =>
          createReviewContext('small', workspacePath, mirrorPath),
        {
          saveReviewedRef: (args) => {
            saveReviewedRefCalls.push(args);
          },
        }
      );
      engine.createRuntime = () => runtime;

      const { run } = await fixture.store.createOrReuseRun(
        createPullRequestPayload('canary-feedback')
      );
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

      const firstCheckpoint = await runtime.execute(run, session.id);
      const runDetailsBeforeResume = await fixture.store.getRunDetails(run.id);
      const droppedFinding = firstCheckpoint.state.policyResult?.dropped.find(
        (finding) => finding.fingerprint === 'gated-finding'
      );

      const persistedCheckpoint = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(
        session.id
      );

      expect(firstCheckpoint.stopReason).toBe('completed');
      expect(droppedFinding).toBeDefined();
      expect(
        runDetailsBeforeResume?.findings.find((finding) => finding.fingerprint === 'gated-finding')
      ).toBeUndefined();
      expect(persistedCheckpoint?.stopReason).toBe('completed');
      expect(saveReviewedRefCalls).toHaveLength(1);
      expect(pullRequestCommentBodies.length).toBeGreaterThanOrEqual(1);
    });

    test('duplicate trigger canary reuses existing run instead of enqueueing effective duplicate work', async () => {
      const engine = kernelReviewEngine as any;
      engine.start = async () => undefined;
      engine._store = fixture.store;

      const payload = createPullRequestPayload('canary-duplicate', { prNumber: 811 });
      const first = await kernelReviewEngine.enqueuePullRequest(payload);
      const second = await kernelReviewEngine.enqueuePullRequest(payload);

      expect(first.reused).toBe(false);
      expect(second.reused).toBe(true);
      expect(second.run.id).toBe(first.run.id);
      expect(await fixture.store.listRuns()).toHaveLength(1);
    });

    test('compression resume canary resumes from compressed checkpoint through feedback flow', async () => {
      const compressedSummary =
        '## Change Overview\n- Resume with compressed state\n\n## High-Risk Areas\n- optional input handling\n\n## Important Files\n- src/module-0.ts\n\n## Open Questions\n- none\n\n## Recommended Focus\n- verify feedback resume after compression';
      initializeFeedbackSystem(fixture.store);
      const saveReviewedRefCalls: Array<{
        mirrorPath: string;
        prNumber: number;
        baseSha: string;
        targetSha: string;
      }> = [];
      const plannerPrompts: string[] = [];
      const specialistPrompts: string[] = [];
      let plannerCallCount = 0;

      modelRoleRepo.getByRole = ((role: string) => {
        if (role === 'planner') {
          return {
            role: 'planner',
            provider_id: 'provider-1',
            model: 'gpt-4o',
            updated_at: new Date().toISOString(),
          };
        }
        return originalGetByRole(role as any);
      }) as typeof modelRoleRepo.getByRole;
      tokenCounter.getContextWindow = () => 4_000;

      llmGateway.chatForRole = async (role, request) => {
        const userMessage = String(request.messages[request.messages.length - 1]?.content ?? '');

        if (role === 'planner') {
          plannerCallCount += 1;
          if (plannerCallCount === 1) {
            return createJsonResponse({ summary: compressedSummary });
          }
          plannerPrompts.push(userMessage);
          return createJsonResponse({
            complexity: 'standard',
            review_size: 'medium',
            mode: 'light',
            relevant_domains: ['correctness'],
            risk_tags: [],
            rationale: 'need correctness review',
          });
        }

        if (role === 'specialist') {
          specialistPrompts.push(userMessage);
          return createJsonResponse({
            findings: [
              {
                fingerprint: 'compressed-publishable',
                severity: 'high',
                confidence: 0.98,
                path: 'src/module-0.ts',
                line: 1,
                title: 'Missing optional chaining before trim',
                detail: '发布型 finding。',
                evidence: 'export const module0 = input.trim();',
                suggestion: '改为 input?.trim()。',
              },
              {
                fingerprint: 'compressed-gated',
                severity: 'low',
                confidence: 0.99,
                path: 'src/module-0.ts',
                line: 1,
                title: 'Need human review after compression',
                detail: '低严重度建议进入人工审批。',
                evidence: 'export const module0 = input.trim();',
                suggestion: '统一做空值保护。',
              },
            ],
          });
        }

        throw new Error(`Unexpected LLM role: ${role}`);
      };

      giteaService.addPullRequestComment = async () => undefined;
      giteaService.addCommitComment = async () => {
        throw new Error('Commit comment should not be used in pull request tests');
      };
      giteaService.addLineComments = async () => undefined;
      giteaService.getRelatedPullRequest = async () => ({ number: 801 }) as any;

      const engine = kernelReviewEngine as any;
      engine.start = async () => undefined;
      engine._store = fixture.store;

      const runtime = createRuntime(
        fixture,
        (_run, mirrorPath, workspacePath) =>
          createReviewContext('compressible', workspacePath, mirrorPath),
        {
          saveReviewedRef: (args) => {
            saveReviewedRefCalls.push(args);
          },
        }
      );
      engine.createRuntime = () => runtime;

      const { run } = await fixture.store.createOrReuseRun(
        createPullRequestPayload('canary-compression-resume')
      );
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

      const firstCheckpoint = await runtime.execute(run, session.id);
      const persistedBeforeResume = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(
        session.id
      );
      const runDetailsBeforeResume = await fixture.store.getRunDetails(run.id);
      const invocationsBeforeResume = kernelSessionRepository.listSubagentInvocations(session.id);
      const droppedFinding = firstCheckpoint.state.policyResult?.dropped.find(
        (finding) => finding.fingerprint === 'compressed-gated'
      );

      expect(firstCheckpoint.stopReason).toBe('completed');
      expect(persistedBeforeResume?.state.compressedContext).toBeDefined();
      expect(persistedBeforeResume?.state).toMatchObject({
        targetSha: run.headSha,
        published: true,
        reviewedRefSaved: true,
      });
      expect(persistedBeforeResume?.pendingTasks).toEqual([]);
      expect(invocationsBeforeResume.filter((item) => item.status === 'completed')).toHaveLength(2);
      expect(invocationsBeforeResume.map((item) => item.subagentName)).toEqual(
        expect.arrayContaining([REVIEW_TRIAGE_SUBAGENT, getReviewDomainSubagentId('correctness')])
      );
      expect(plannerCallCount).toBe(2);
      expect(plannerPrompts[0]).toContain(compressedSummary);
      expect(specialistPrompts[0]).toContain(compressedSummary);
      const persistedAfterResume = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(
        session.id
      );
      const invocationsAfterResume = kernelSessionRepository.listSubagentInvocations(session.id);

      expect(droppedFinding).toBeDefined();
      expect(
        runDetailsBeforeResume?.findings.find(
          (finding) => finding.fingerprint === 'compressed-gated'
        )
      ).toBeUndefined();
      expect(persistedAfterResume?.stopReason).toBe('completed');
      expect(persistedAfterResume?.state).toMatchObject({
        targetSha: run.headSha,
        published: true,
        reviewedRefSaved: true,
      });
      expect(persistedAfterResume?.state.compressedContext).toMatchObject({
        summary: expect.stringContaining('## Change Overview'),
      });
      expect(invocationsAfterResume).toHaveLength(invocationsBeforeResume.length);
      expect(saveReviewedRefCalls).toHaveLength(1);
    });

    test('line comment publish failure canary leaves a failed checkpoint without published line records', async () => {
      llmGateway.chatForRole = async (role) => {
        if (role !== 'specialist') {
          throw new Error(`Unexpected LLM role: ${role}`);
        }
        return createJsonResponse({
          findings: [
            {
              fingerprint: 'line-comment-failure',
              severity: 'high',
              confidence: 0.98,
              path: 'src/index.ts',
              line: 2,
              title: 'Line comment publish failure',
              detail: '用于验证 line comment 失败时的恢复语义。',
              evidence: 'return input.trim() === "on";',
              suggestion: '改为 input?.trim() === "on"。',
            },
          ],
        });
      };

      giteaService.addPullRequestComment = async () => undefined;
      giteaService.addCommitComment = async () => {
        throw new Error('Commit comment should not be used in pull request tests');
      };
      giteaService.addLineComments = async () => {
        throw new Error('line comment publish failed');
      };
      giteaService.getRelatedPullRequest = async () => ({ number: 801 }) as any;

      const { run } = await fixture.store.createOrReuseRun(
        createPullRequestPayload('canary-line-comment-failure')
      );
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

      await expect(
        createRuntime(fixture, (_run, mirrorPath, workspacePath) =>
          createReviewContext('small', workspacePath, mirrorPath)
        ).execute(run, session.id)
      ).rejects.toThrow('line comment publish failed');

      const persistedCheckpoint = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(
        session.id
      );
      const runDetails = await fixture.store.getRunDetails(run.id);

      expect(persistedCheckpoint?.stopReason).toBe('failed');
      expect(persistedCheckpoint?.state.published).toBe(false);
      expect(persistedCheckpoint?.pendingTasks).toEqual([
        expect.objectContaining({ kind: 'skill', name: 'publish_review' }),
      ]);
      expect(runDetails?.comments.filter((comment) => comment.path)).toEqual([]);
    });

    test('save reviewed ref failure canary preserves published state for retry while leaving ref unsaved', async () => {
      const saveReviewedRefCalls: Array<{
        mirrorPath: string;
        prNumber: number;
        baseSha: string;
        targetSha: string;
      }> = [];

      llmGateway.chatForRole = async (role) => {
        if (role !== 'specialist') {
          throw new Error(`Unexpected LLM role: ${role}`);
        }
        return createJsonResponse({
          findings: [
            {
              fingerprint: 'save-ref-failure',
              severity: 'high',
              confidence: 0.98,
              path: 'src/index.ts',
              line: 2,
              title: 'Reviewed ref save failure',
              detail: '用于验证 reviewed ref 保存失败时的恢复语义。',
              evidence: 'return input.trim() === "on";',
              suggestion: '改为 input?.trim() === "on"。',
            },
          ],
        });
      };

      giteaService.addPullRequestComment = async () => undefined;
      giteaService.addCommitComment = async () => {
        throw new Error('Commit comment should not be used in pull request tests');
      };
      giteaService.addLineComments = async () => undefined;
      giteaService.getRelatedPullRequest = async () => ({ number: 801 }) as any;

      const { run } = await fixture.store.createOrReuseRun(
        createPullRequestPayload('canary-save-ref-failure')
      );
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

      await expect(
        createRuntime(
          fixture,
          (_run, mirrorPath, workspacePath) =>
            createReviewContext('small', workspacePath, mirrorPath),
          {
            saveReviewedRef: (args) => {
              saveReviewedRefCalls.push(args);
              throw new Error('save reviewed ref failed');
            },
          }
        ).execute(run, session.id)
      ).rejects.toThrow('save reviewed ref failed');

      const persistedCheckpoint = kernelSessionRepository.loadCheckpoint<ReviewKernelState>(
        session.id
      );
      const runDetails = await fixture.store.getRunDetails(run.id);

      expect(saveReviewedRefCalls).toHaveLength(1);
      expect(persistedCheckpoint?.stopReason).toBe('failed');
      expect(persistedCheckpoint?.state).toMatchObject({
        published: true,
        reviewedRefSaved: false,
      });
      expect(persistedCheckpoint?.pendingTasks).toEqual([
        expect.objectContaining({ kind: 'skill', name: 'save_reviewed_ref' }),
      ]);
      expect(
        runDetails?.comments.filter((comment) => comment.status === 'published').length
      ).toBeGreaterThan(0);
    });
  });
});
