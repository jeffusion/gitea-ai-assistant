import { describe, expect, test } from 'bun:test';
import type { LLMGateway } from '../../llm/gateway';
import type { LLMChatResponse, ModelRole } from '../../llm/types';
import { TriageAgent } from '../agents/triage-agent';
import type { ChangedFile, FindingCategory, ReviewContext } from '../types';

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
  request: any;
};

function createMockGateway(
  implementation: (role: ModelRole, request: any) => Promise<LLMChatResponse>
) {
  const calls: ChatCall[] = [];

  return {
    gateway: {
      chatForRole: async (role: ModelRole, request: any) => {
        calls.push({ role, request });
        return implementation(role, request);
      },
    },
    getCalls: () => calls,
  };
}

describe('TriageAgent task-based routing', () => {
  test('heuristic: empty changedFiles -> skip mode with no tasks', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(
        JSON.stringify({
          complexity: 'complex',
          review_size: 'large',
          mode: 'full',
          relevant_domains: ['correctness', 'security', 'quality'],
        })
      )
    );
    const agent = new TriageAgent(gateway as any);

    const result = await agent.analyze(makeContext({ changedFiles: [] }));

    expect(result.mode).toBe('skip');
    expect(result.tasks).toHaveLength(0);
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: docs/assets only -> skip mode with no tasks', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(
        JSON.stringify({
          complexity: 'complex',
          review_size: 'large',
          mode: 'full',
          relevant_domains: ['correctness', 'security', 'quality'],
        })
      )
    );
    const agent = new TriageAgent(gateway as any);

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
    expect(result.tasks).toHaveLength(0);
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: tiny single-file code change -> light correctness task', async () => {
    const { gateway, getCalls } = createMockGateway(async () => makeChatResponse(null));
    const agent = new TriageAgent(gateway as any);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [makeChangedFile({ path: 'src/app.ts', additions: 1, deletions: 2 })],
      })
    );

    expect(result.mode).toBe('light');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].domain).toBe('correctness');
    expect(result.tasks[0].allowTools).toBe(false);
    expect(result.tasks[0].maxIterations).toBe(1);
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: security-sensitive small change -> full correctness+security tasks', async () => {
    const { gateway, getCalls } = createMockGateway(async () => makeChatResponse(null));
    const agent = new TriageAgent(gateway as any);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [
          makeChangedFile({ path: 'src/auth/service.ts', additions: 12, deletions: 6 }),
          makeChangedFile({ path: 'src/user/profile.ts', additions: 10, deletions: 4 }),
        ],
      })
    );

    expect(result.mode).toBe('full');
    const domains = result.tasks.map((task) => task.domain);
    expect(domains).toContain('correctness');
    expect(domains).toContain('security');
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: large PR by file count -> full mode with all domains', async () => {
    const { gateway, getCalls } = createMockGateway(async () => makeChatResponse(null));
    const agent = new TriageAgent(gateway as any);

    const changedFiles = Array.from({ length: 21 }, (_, index) =>
      makeChangedFile({ path: `src/file-${index}.ts`, additions: 2, deletions: 1 })
    );

    const result = await agent.analyze(makeContext({ changedFiles }));

    expect(result.mode).toBe('full');
    expect(result.reviewSize).toBe('large');
    expect(result.complexity).toBe('complex');
    const expectedDomains: FindingCategory[] = ['correctness', 'quality', 'security'];
    expect(result.tasks.map((task) => task.domain).sort()).toEqual(expectedDomains.sort());
    expect(getCalls()).toHaveLength(0);
  });

  test('LLM fallback: inconclusive change uses planner and normalizes tasks', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(
        JSON.stringify({
          complexity: 'standard',
          review_size: 'medium',
          mode: 'light',
          relevant_domains: ['security', 'quality'],
          risk_tags: ['security-sensitive'],
          rationale: '跨文件业务逻辑调整',
        })
      )
    );
    const agent = new TriageAgent(gateway as any);

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

    expect(result.reviewSize).toBe('medium');
    expect(result.mode).toBe('light');
    expect(result.tasks.map((task) => task.domain)).toContain('correctness');
    expect(result.tasks.map((task) => task.domain)).toContain('security');
    expect(result.rationale).toBe('跨文件业务逻辑调整');
  });

  test('LLM fallback: planner system message keeps full project prompt', async () => {
    const longProjectPrompt = `repo-policy-${'P'.repeat(420)}`;
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(
        JSON.stringify({
          complexity: 'standard',
          review_size: 'medium',
          mode: 'light',
          relevant_domains: ['correctness'],
          risk_tags: ['quality-sensitive'],
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

  test('LLM fallback: planner throws -> default full review with all domains', async () => {
    const { gateway, getCalls } = createMockGateway(async () => {
      throw new Error('planner unavailable');
    });
    const agent = new TriageAgent(gateway as any);

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
    const expectedDomains: FindingCategory[] = ['correctness', 'quality', 'security'];
    expect(result.tasks.map((task) => task.domain).sort()).toEqual(expectedDomains.sort());
    expect(result.rationale).toContain('LLM');
  });
});
