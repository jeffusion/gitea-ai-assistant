import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { LLMGateway } from '../../llm/gateway';
import type {
  LLMChatRequest,
  LLMChatResponse,
  LLMMessage,
  LLMToolDefinition,
  ModelRole,
} from '../../llm/types';
import { AutonomousReviewAgent } from '../agents/autonomous-review-agent';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import type { ReviewContext, ReviewRun, ReviewTask } from '../types';

type ChatRequest = {
  messages: LLMMessage[];
  temperature?: number;
  responseFormat?: 'text' | 'json';
  tools?: LLMToolDefinition[];
  providerOptions?: Record<string, unknown>;
};

type ChatCall = { role: ModelRole } & ChatRequest;

function makeRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'run-autonomous-001',
    idempotencyKey: 'idem-autonomous',
    eventType: 'pull_request',
    status: 'in_progress',
    owner: 'test-owner',
    repo: 'test-repo',
    cloneUrl: 'https://example.com/repo.git',
    prNumber: 1,
    baseSha: 'aaa',
    headSha: 'bbb',
    attempts: 0,
    maxAttempts: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    workspacePath: '/tmp/test-workspace',
    mirrorPath: '/tmp/test-mirror',
    diff: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,4 @@\n+const x = null;\n export function foo() {}',
    changedFiles: [{ path: 'src/foo.ts', status: 'M', additions: 1, deletions: 0 }],
    parsedDiff: [
      {
        path: 'src/foo.ts',
        changes: [{ lineNumber: 1, content: 'const x = null;', type: 'add' }],
      },
    ],
    fileContents: { 'src/foo.ts': 'const x = null;\nexport function foo() {}' },
    ...overrides,
  };
}

function makeTask(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    mode: 'full',
    reviewSize: 'medium',
    riskTags: ['quality-sensitive'],
    suspectedEntrypoints: ['src/foo.ts'],
    tokenBudget: 8000,
    ...overrides,
  };
}

function makeTool(name: string, execute: Tool['execute']): Tool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: z.object({ query: z.string().optional(), file_path: z.string().optional() }),
    isConcurrencySafe: true,
    execute,
  };
}

function createMockGateway(responses: Array<() => LLMChatResponse>) {
  let callIndex = 0;
  const calls: ChatCall[] = [];

  return {
    gateway: {
      chatForRole: async (role: ModelRole, request: Omit<LLMChatRequest, 'model'>) => {
        calls.push({ role, ...request });
        const responseFn = responses[callIndex] ?? responses[responses.length - 1];
        callIndex++;
        return responseFn();
      },
    },
    getCalls: () => calls,
  };
}

function toolCallResponse(
  toolCalls: Array<{ id: string; name: string; args: unknown }>
): LLMChatResponse {
  return {
    content: null,
    toolCalls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.args),
    })),
    finishReason: 'tool_calls',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function contentResponse(content: string): LLMChatResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function jsonResponse(data: unknown): LLMChatResponse {
  return contentResponse(JSON.stringify(data));
}

describe('AutonomousReviewAgent', () => {
  test('model-driven investigation can search, read, then finalize without forced tool_choice or investigation JSON mode', async () => {
    const registry = new ToolRegistry();
    const searchCode = mock(async () => ({ results: ['src/foo.ts contains null'] }));
    const readFile = mock(async () => ({ path: 'src/foo.ts', content: 'const x = null;' }));
    registry.register(makeTool('search_code', searchCode));
    registry.register(makeTool('read_file', readFile));

    const finding = {
      category: 'quality' as const,
      severity: 'medium' as const,
      confidence: 0.84,
      path: 'src/foo.ts',
      line: 1,
      title: 'Null assignment needs guard',
      detail: 'The new value is null and later code assumes a value.',
      evidence: 'const x = null;',
      suggestion: 'Use a safe default or guard downstream access.',
    };
    const { gateway, getCalls } = createMockGateway([
      () => toolCallResponse([{ id: 'call_1', name: 'search_code', args: { query: 'null' } }]),
      () =>
        toolCallResponse([{ id: 'call_2', name: 'read_file', args: { file_path: 'src/foo.ts' } }]),
      () => jsonResponse({ findings: [finding] }),
    ]);

    const agent = new AutonomousReviewAgent(gateway as unknown as LLMGateway, registry);
    const result = await agent.review(makeRun(), makeContext(), makeTask());

    expect(searchCode).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ category: 'quality', path: 'src/foo.ts' });

    const calls = getCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0].role).toBe('specialist');
    expect(calls[0].tools?.map((tool) => tool.name)).toEqual(['search_code', 'read_file']);
    expect(calls[0].responseFormat).toBeUndefined();
    expect(calls[0].providerOptions).toBeUndefined();
    expect(calls[1].responseFormat).toBeUndefined();
    expect(calls[1].providerOptions).toBeUndefined();
    expect(result.diagnostics).toMatchObject({
      iterations: 3,
      toolCallNames: ['search_code', 'read_file'],
      toolCallCount: 2,
      parsedFindingCount: 1,
      stopReason: 'modelFinalized',
    });
    expect(result.diagnostics?.stateSequence).toEqual([
      'investigating',
      'tool_calling',
      'investigating',
      'tool_calling',
      'investigating',
      'finalizing',
      'completed',
    ]);
  });

  test('uses default light budget and synthesizes after maxTurns when task omits specific limits', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('search_code', async () => ({ results: [] })));
    const { gateway, getCalls } = createMockGateway([
      () => toolCallResponse([{ id: 'call_1', name: 'search_code', args: { query: 'a' } }]),
      () => toolCallResponse([{ id: 'call_2', name: 'search_code', args: { query: 'b' } }]),
      () => toolCallResponse([{ id: 'call_3', name: 'search_code', args: { query: 'c' } }]),
      () => toolCallResponse([{ id: 'call_4', name: 'search_code', args: { query: 'd' } }]),
      () => jsonResponse({ findings: [] }),
    ]);

    const agent = new AutonomousReviewAgent(gateway as unknown as LLMGateway, registry);
    const result = await agent.review(
      makeRun(),
      makeContext(),
      makeTask({
        mode: 'light',
        maxTurns: undefined,
        maxToolCalls: undefined,
        maxElapsedMs: undefined,
      })
    );

    expect(getCalls()).toHaveLength(5);
    expect(getCalls()[4].responseFormat).toBe('json');
    expect(result.findings).toHaveLength(0);
    expect(result.diagnostics).toMatchObject({
      iterations: 4,
      toolCallCount: 4,
      stopReason: 'maxTurns',
      parsedFindingCount: 0,
    });
    expect(result.diagnostics?.stateSequence).toContain('synthesizing');
  });

  test('finalization repairs invalid JSON once and accepts valid JSON on second attempt', async () => {
    const validFinding = {
      severity: 'high' as const,
      confidence: 0.91,
      path: 'src/foo.ts',
      line: 1,
      title: 'Unsafe null',
      detail: 'Null is returned to callers that expect a string.',
      evidence: 'const x = null;',
      suggestion: 'Return a string or update callers to handle null.',
    };
    const { gateway, getCalls } = createMockGateway([
      () => contentResponse('not valid json'),
      () => jsonResponse({ findings: [validFinding] }),
    ]);

    const agent = new AutonomousReviewAgent(gateway as unknown as LLMGateway);
    const result = await agent.review(makeRun(), makeContext(), makeTask({ mode: 'light' }));

    expect(getCalls()).toHaveLength(2);
    expect(getCalls()[0].responseFormat).toBeUndefined();
    expect(getCalls()[1].responseFormat).toBe('json');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].category).toBe('correctness');
    expect(result.findings[0].fingerprint).toBeTruthy();
    expect(result.diagnostics?.parseErrors?.length).toBe(1);
    expect(result.diagnostics?.finalResponsePreview).toContain('Unsafe null');
  });

  test('stops after two consecutive empty investigation responses', async () => {
    const { gateway } = createMockGateway([
      () => ({
        content: null,
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      () => ({
        content: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      () => jsonResponse({ findings: [] }),
    ]);

    const agent = new AutonomousReviewAgent(gateway as unknown as LLMGateway);
    const result = await agent.review(makeRun(), makeContext(), makeTask());

    expect(result.findings).toHaveLength(0);
    expect(result.diagnostics).toMatchObject({
      emptyResponseCount: 2,
      stopReason: 'emptyResponses',
      parsedFindingCount: 0,
    });
  });

  test('stops after three consecutive tool failures and records sequence', async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeTool('broken_tool', async () => {
        throw new Error('boom');
      })
    );
    const { gateway } = createMockGateway([
      () => toolCallResponse([{ id: 'call_1', name: 'broken_tool', args: {} }]),
      () => toolCallResponse([{ id: 'call_2', name: 'broken_tool', args: {} }]),
      () => toolCallResponse([{ id: 'call_3', name: 'broken_tool', args: {} }]),
      () => jsonResponse({ findings: [] }),
    ]);

    const agent = new AutonomousReviewAgent(gateway as unknown as LLMGateway, registry);
    const result = await agent.review(makeRun(), makeContext(), makeTask({ maxTurns: 10 }));

    expect(result.findings).toHaveLength(0);
    expect(result.diagnostics).toMatchObject({
      toolCallNames: ['broken_tool', 'broken_tool', 'broken_tool'],
      consecutiveToolFailures: 3,
      stopReason: 'toolFailures',
    });
  });
});
