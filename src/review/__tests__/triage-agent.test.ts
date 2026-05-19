import { describe, expect, test } from 'bun:test';
import type { LLMGateway } from '../../llm/gateway';
import type { LLMChatRequest, LLMChatResponse, ModelRole } from '../../llm/types';
import { TriageAgent } from '../agents/triage-agent';
import type { ChangedFile, ReviewContext } from '../types';

function makeChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'src/file.ts',
    status: 'M',
    additions: 1,
    deletions: 1,
    ...overrides,
  };
}

function makeContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    workspacePath: '/tmp/workspace',
    mirrorPath: '/tmp/mirror',
    diff: 'diff --git a/src/file.ts b/src/file.ts\n+const x = 1;',
    changedFiles: [makeChangedFile()],
    parsedDiff: [],
    fileContents: {},
    ...overrides,
  };
}

function makeChatResponse(content: string | null): LLMChatResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

type ChatCall = {
  role: ModelRole;
  request: Omit<LLMChatRequest, 'model'>;
};

function createMockGateway(
  implementation: (
    role: ModelRole,
    request: Omit<LLMChatRequest, 'model'>
  ) => Promise<LLMChatResponse>
) {
  const calls: ChatCall[] = [];
  const gateway: Pick<LLMGateway, 'chatForRole'> = {
    chatForRole: async (role: ModelRole, request: Omit<LLMChatRequest, 'model'>) => {
      calls.push({ role, request });
      return implementation(role, request);
    },
  };

  return {
    gateway,
    getCalls: () => calls,
  };
}

describe('TriageAgent hint-based planning', () => {
  test('heuristic: empty changedFiles -> skip mode with hints only', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(
        JSON.stringify({
          review_size: 'large',
          mode: 'full',
          suspected_entrypoints: ['src/ignored.ts'],
        })
      )
    );
    const agent = new TriageAgent(gateway as unknown as LLMGateway);

    const result = await agent.analyze(makeContext({ changedFiles: [] }));

    expect(result.mode).toBe('skip');
    expect('tasks' in result).toBe(false);
    expect(result.suspectedEntrypoints).toEqual([]);
    expect(result.budgetHints).toEqual({
      maxTurns: 0,
      maxToolCalls: 0,
      maxElapsedMs: 0,
      tokenBudget: 0,
    });
    expect(result.changedFileSummary.totalFiles).toBe(0);
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: docs/assets only -> skip mode with hints only', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(
        JSON.stringify({
          review_size: 'large',
          mode: 'full',
          suspected_entrypoints: ['src/ignored.ts'],
        })
      )
    );
    const agent = new TriageAgent(gateway as unknown as LLMGateway);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [
          makeChangedFile({ path: 'README.md' }),
          makeChangedFile({ path: 'docs/usage.adoc' }),
          makeChangedFile({ path: 'assets/logo.png' }),
        ],
      })
    );

    expect(result.mode).toBe('skip');
    expect('tasks' in result).toBe(false);
    expect(result.suspectedEntrypoints).toEqual([]);
    expect(result.changedFileSummary.files).toContain('M README.md (+1 -1)');
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: tiny single-file code change -> light hints only', async () => {
    const { gateway, getCalls } = createMockGateway(async () => makeChatResponse(null));
    const agent = new TriageAgent(gateway as unknown as LLMGateway);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [makeChangedFile({ path: 'src/app.ts', additions: 1, deletions: 2 })],
      })
    );

    expect(result.mode).toBe('light');
    expect('tasks' in result).toBe(false);
    expect(result.suspectedEntrypoints).toEqual(['src/app.ts']);
    expect(result.budgetHints).toMatchObject({
      maxTurns: 4,
      maxToolCalls: 4,
      maxElapsedMs: 60_000,
    });
    expect(result.changedFileSummary).toMatchObject({
      totalFiles: 1,
      totalAdditions: 1,
      totalDeletions: 2,
    });
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: security-sensitive small change -> full hints only', async () => {
    const { gateway, getCalls } = createMockGateway(async () => makeChatResponse(null));
    const agent = new TriageAgent(gateway as unknown as LLMGateway);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [
          makeChangedFile({ path: 'src/auth/service.ts', additions: 12, deletions: 6 }),
          makeChangedFile({ path: 'src/user/profile.ts', additions: 10, deletions: 4 }),
        ],
      })
    );

    expect(result.mode).toBe('full');
    expect('tasks' in result).toBe(false);
    expect(result.riskTags).toContain('security-sensitive');
    expect(result.suspectedEntrypoints).toEqual(['src/auth/service.ts', 'src/user/profile.ts']);
    expect(result.budgetHints).toMatchObject({
      maxTurns: 10,
      maxToolCalls: 12,
      maxElapsedMs: 180_000,
    });
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: large PR by file count -> large full budget hints', async () => {
    const { gateway, getCalls } = createMockGateway(async () => makeChatResponse(null));
    const agent = new TriageAgent(gateway as unknown as LLMGateway);

    const changedFiles = Array.from({ length: 21 }, (_, index) =>
      makeChangedFile({ path: `src/file-${index}.ts`, additions: 2, deletions: 1 })
    );

    const result = await agent.analyze(makeContext({ changedFiles }));

    expect(result.mode).toBe('full');
    expect(result.reviewSize).toBe('large');
    expect('tasks' in result).toBe(false);
    expect(result.budgetHints).toMatchObject({
      maxTurns: 12,
      maxToolCalls: 16,
      maxElapsedMs: 240_000,
    });
    expect(result.suspectedEntrypoints).toHaveLength(12);
    expect(result.changedFileSummary.files).toHaveLength(12);
    expect(getCalls()).toHaveLength(0);
  });

  test('LLM fallback: inconclusive change uses planner and normalizes hints', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(
        JSON.stringify({
          review_size: 'medium',
          mode: 'light',
          risk_tags: ['security-sensitive'],
          suspected_entrypoints: ['src/service/order.ts', 'src/controller/order.ts'],
          rationale: '跨文件业务逻辑调整',
        })
      )
    );
    const agent = new TriageAgent(gateway as unknown as LLMGateway);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [
          makeChangedFile({ path: 'src/service/order.ts', additions: 20, deletions: 10 }),
          makeChangedFile({ path: 'src/controller/order.ts', additions: 18, deletions: 12 }),
          makeChangedFile({ path: 'src/repo/order.ts', additions: 15, deletions: 12 }),
          makeChangedFile({ path: 'src/model/order.ts', additions: 14, deletions: 13 }),
        ],
      })
    );

    const calls = getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].role).toBe('planner');
    expect(calls[0].request.temperature).toBe(0);
    expect(calls[0].request.responseFormat).toBe('json');
    const plannerMessages = calls[0].request.messages as Array<{ role: string; content: string }>;
    const plannerUserMessage = plannerMessages.find((message) => message.role === 'user');
    expect(plannerUserMessage?.content).not.toContain('relevant_domains');
    expect(plannerUserMessage?.content).not.toContain('"tasks"');
    expect(plannerUserMessage?.content).not.toContain('可选领域');

    expect(result.reviewSize).toBe('medium');
    expect(result.mode).toBe('light');
    expect('tasks' in result).toBe(false);
    expect(result.suspectedEntrypoints).toEqual([
      'src/service/order.ts',
      'src/controller/order.ts',
    ]);
    expect(result.riskTags).toEqual(['security-sensitive']);
    expect(result.rationale).toBe('跨文件业务逻辑调整');
  });

  test('LLM fallback: planner system message keeps full project prompt', async () => {
    const longProjectPrompt = `repo-policy-${'P'.repeat(420)}`;
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(
        JSON.stringify({
          review_size: 'medium',
          mode: 'light',
          risk_tags: ['quality-sensitive'],
          suspected_entrypoints: ['src/service/order.ts'],
          rationale: '需要模型判断',
        })
      )
    );

    const agent = new TriageAgent(gateway as unknown as LLMGateway);

    await agent.analyze(
      makeContext({
        changedFiles: [
          makeChangedFile({ path: 'src/service/order.ts', additions: 20, deletions: 10 }),
          makeChangedFile({ path: 'src/controller/order.ts', additions: 18, deletions: 12 }),
          makeChangedFile({ path: 'src/repo/order.ts', additions: 15, deletions: 12 }),
          makeChangedFile({ path: 'src/model/order.ts', additions: 14, deletions: 13 }),
        ],
      }),
      { projectPrompt: longProjectPrompt }
    );

    const calls = getCalls();
    expect(calls).toHaveLength(1);

    const plannerMessages = calls[0].request.messages as Array<{ role: string; content: string }>;
    const plannerSystemMessage = plannerMessages.find((message) => message.role === 'system');

    expect(plannerSystemMessage?.content).toContain(longProjectPrompt);
  });

  test('LLM fallback: planner throws -> default full review hints', async () => {
    const { gateway, getCalls } = createMockGateway(async () => {
      throw new Error('planner unavailable');
    });
    const agent = new TriageAgent(gateway as unknown as LLMGateway);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [
          makeChangedFile({ path: 'src/service/foo.ts', additions: 20, deletions: 12 }),
          makeChangedFile({ path: 'src/service/bar.ts', additions: 18, deletions: 10 }),
          makeChangedFile({ path: 'src/service/baz.ts', additions: 16, deletions: 8 }),
          makeChangedFile({ path: 'src/service/qux.ts', additions: 12, deletions: 6 }),
          makeChangedFile({ path: 'src/service/quux.ts', additions: 10, deletions: 4 }),
        ],
      })
    );

    expect(getCalls()).toHaveLength(1);
    expect(result.mode).toBe('full');
    expect('tasks' in result).toBe(false);
    expect(result.suspectedEntrypoints).toContain('src/service/foo.ts');
    expect(result.budgetHints).toMatchObject({
      maxTurns: 10,
      maxToolCalls: 12,
      maxElapsedMs: 180_000,
    });
    expect(result.rationale).toContain('LLM');
  });
});
