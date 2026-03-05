import { describe, expect, test } from 'bun:test';
import type { LLMChatResponse, ModelRole } from '../../llm/types';
import { TriageAgent } from '../agents/triage-agent';
import type { ChangedFile, FindingCategory, ReviewContext } from '../types';

const ALL_DOMAINS: FindingCategory[] = [
  'correctness',
  'security',
  'reliability',
  'maintainability',
];

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

describe('TriageAgent', () => {
  test('heuristic: empty changedFiles -> trivial + correctness (no LLM call)', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(JSON.stringify({ complexity: 'complex', relevant_domains: ALL_DOMAINS }))
    );
    const agent = new TriageAgent(gateway as any);

    const result = await agent.analyze(makeContext({ changedFiles: [] }));

    expect(result.complexity).toBe('trivial');
    expect(result.relevantDomains).toEqual(['correctness']);
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: all non-code files -> trivial + correctness (no LLM call)', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(JSON.stringify({ complexity: 'complex', relevant_domains: ALL_DOMAINS }))
    );
    const agent = new TriageAgent(gateway as any);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [
          makeChangedFile({ path: 'README.md' }),
          makeChangedFile({ path: 'config/app.json' }),
          makeChangedFile({ path: 'styles/base.css' }),
          makeChangedFile({ path: 'assets/logo.png' }),
          makeChangedFile({ path: 'bun.lock', additions: 10, deletions: 10 }),
        ],
      })
    );

    expect(result.complexity).toBe('trivial');
    expect(result.relevantDomains).toEqual(['correctness']);
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: single file <=3 line changes -> trivial + correctness (no LLM call)', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(JSON.stringify({ complexity: 'complex', relevant_domains: ALL_DOMAINS }))
    );
    const agent = new TriageAgent(gateway as any);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [makeChangedFile({ path: 'src/app.ts', additions: 1, deletions: 2 })],
      })
    );

    expect(result.complexity).toBe('trivial');
    expect(result.relevantDomains).toEqual(['correctness']);
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: security-sensitive small PR -> standard + correctness/security (no LLM call)', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(JSON.stringify({ complexity: 'complex', relevant_domains: ALL_DOMAINS }))
    );
    const agent = new TriageAgent(gateway as any);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [
          makeChangedFile({ path: 'src/auth/service.ts', additions: 20, deletions: 10 }),
          makeChangedFile({ path: 'src/user/profile.ts', additions: 5, deletions: 5 }),
        ],
      })
    );

    expect(result.complexity).toBe('standard');
    expect(result.relevantDomains).toEqual(['correctness', 'security']);
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: large PR by file count (>20) -> complex + all domains (no LLM call)', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(
        JSON.stringify({ complexity: 'standard', relevant_domains: ['correctness'] })
      )
    );
    const agent = new TriageAgent(gateway as any);

    const changedFiles = Array.from({ length: 21 }, (_, index) =>
      makeChangedFile({ path: `src/file-${index}.ts`, additions: 2, deletions: 1 })
    );

    const result = await agent.analyze(makeContext({ changedFiles }));

    expect(result.complexity).toBe('complex');
    expect(result.relevantDomains).toEqual(ALL_DOMAINS);
    expect(getCalls()).toHaveLength(0);
  });

  test('heuristic: large PR by total changes (>500) -> complex + all domains (no LLM call)', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(
        JSON.stringify({ complexity: 'standard', relevant_domains: ['correctness'] })
      )
    );
    const agent = new TriageAgent(gateway as any);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [
          makeChangedFile({ path: 'src/a.ts', additions: 250, deletions: 10 }),
          makeChangedFile({ path: 'src/b.ts', additions: 240, deletions: 10 }),
        ],
      })
    );

    expect(result.complexity).toBe('complex');
    expect(result.relevantDomains).toEqual(ALL_DOMAINS);
    expect(getCalls()).toHaveLength(0);
  });

  test('LLM fallback: standard code change calls planner and returns parsed JSON result', async () => {
    const { gateway, getCalls } = createMockGateway(async () =>
      makeChatResponse(
        JSON.stringify({
          complexity: 'standard',
          relevant_domains: ['security', 'maintainability'],
          rationale: '跨文件业务逻辑调整',
        })
      )
    );
    const agent = new TriageAgent(gateway as any);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [
          makeChangedFile({ path: 'src/service/order.ts', additions: 10, deletions: 6 }),
          makeChangedFile({ path: 'src/controller/order.ts', additions: 12, deletions: 8 }),
          makeChangedFile({ path: 'src/repo/order.ts', additions: 8, deletions: 6 }),
        ],
        diff: 'diff --git a/src/service/order.ts b/src/service/order.ts\n+export function calc(){}',
      })
    );

    const calls = getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].role).toBe('planner');
    expect(calls[0].request.temperature).toBe(0);
    expect(calls[0].request.responseFormat).toBe('json');

    expect(result.complexity).toBe('standard');
    expect(result.relevantDomains).toEqual(['correctness', 'security', 'maintainability']);
    expect(result.rationale).toBe('跨文件业务逻辑调整');
  });

  test('LLM fallback: planner throws -> fallback standard + all domains', async () => {
    const { gateway, getCalls } = createMockGateway(async () => {
      throw new Error('planner unavailable');
    });
    const agent = new TriageAgent(gateway as any);

    const result = await agent.analyze(
      makeContext({
        changedFiles: [
          makeChangedFile({ path: 'src/service/foo.ts', additions: 10, deletions: 4 }),
          makeChangedFile({ path: 'src/service/bar.ts', additions: 12, deletions: 6 }),
          makeChangedFile({ path: 'src/service/baz.ts', additions: 8, deletions: 10 }),
        ],
      })
    );

    expect(getCalls()).toHaveLength(1);
    expect(result.complexity).toBe('standard');
    expect(result.relevantDomains).toEqual(ALL_DOMAINS);
    expect(result.rationale).toContain('LLM');
  });
});
