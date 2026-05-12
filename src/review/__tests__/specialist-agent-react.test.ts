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
import { SpecialistAgent } from '../agents/specialist-agent';
import { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import type { FindingCategory, ReviewContext, ReviewRun } from '../types';

function makeRun(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'run-test-001',
    idempotencyKey: 'idem-test',
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

function makeDummyTool(name = 'search_code'): Tool {
  return {
    name,
    description: 'Search code in the workspace',
    parameters: z.object({ query: z.string() }),
    isConcurrencySafe: true,
    execute: async () => ({ results: [] }),
  };
}

type ChatRequest = {
  messages: LLMMessage[];
  temperature?: number;
  responseFormat?: 'text' | 'json';
  tools?: LLMToolDefinition[];
  providerOptions?: Record<string, unknown>;
};

type ChatCall = { role: ModelRole } & ChatRequest;

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
  toolCalls: Array<{ id: string; name: string; args: any }>
): LLMChatResponse {
  return {
    content: null,
    toolCalls: toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: JSON.stringify(tc.args),
    })),
    finishReason: 'tool_calls',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function jsonResponse(data: any): LLMChatResponse {
  return {
    content: JSON.stringify(data),
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function emptyResponse(): LLMChatResponse {
  return {
    content: null,
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

describe('SpecialistAgent ReAct loop', () => {
  const category: FindingCategory = 'correctness';

  test('empty diff returns empty findings without calling OpenAI', async () => {
    const { gateway } = createMockGateway([]);
    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs');
    const result = await agent.review(makeRun(), makeContext({ diff: '   ' }));
    expect(result.findings).toHaveLength(0);
    expect(result.agentName).toBe('TestAgent');
  });

  test('no toolRegistry → uses single-call json mode', async () => {
    const finding = {
      severity: 'high',
      confidence: 0.9,
      path: 'src/foo.ts',
      line: 1,
      title: 'Null assignment',
      detail: 'x is null',
      evidence: 'const x = null',
      suggestion: 'Use undefined',
    };

    const { gateway, getCalls } = createMockGateway([() => jsonResponse({ findings: [finding] })]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs');
    const result = await agent.review(makeRun(), makeContext());

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
    expect(result.findings[0].category).toBe('correctness');
    expect(result.findings[0].fingerprint).toBeTruthy();

    const calls = getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].responseFormat).toBe('json');
  });

  test('ReAct: tool call → tool result → final JSON findings', async () => {
    const registry = new ToolRegistry();
    const executeFn = mock(async () => ({ results: ['some code match'] }));
    registry.register({ ...makeDummyTool(), execute: executeFn });

    const finding = {
      severity: 'medium',
      confidence: 0.85,
      path: 'src/foo.ts',
      line: 1,
      title: 'Potential null',
      detail: 'Null assigned',
      evidence: 'const x = null',
      suggestion: 'Check usage',
    };

    const { gateway, getCalls } = createMockGateway([
      () => toolCallResponse([{ id: 'call_1', name: 'search_code', args: { query: 'null' } }]),
      () => jsonResponse({ findings: [finding], need_more_investigation: false }),
    ]);

    const agent = new SpecialistAgent(
      gateway as unknown as LLMGateway,
      category,
      'TestAgent',
      'bugs',
      registry
    );
    const result = await agent.review(makeRun(), makeContext());

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].category).toBe('correctness');

    const calls = getCalls();
    expect(calls).toHaveLength(2);
  });

  test('ReAct: default staged mode uses 2 iterations and forces final json', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDummyTool());

    const { gateway, getCalls } = createMockGateway([
      () => toolCallResponse([{ id: 'call_1', name: 'search_code', args: { query: 'x' } }]),
      () => jsonResponse({ findings: [], need_more_investigation: false }),
    ]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs', registry);
    await agent.review(makeRun(), makeContext());

    const calls = getCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].providerOptions).toEqual({ tool_choice: 'auto' });
    expect(calls[0].responseFormat).toBeUndefined();
    expect(calls[1].providerOptions).toEqual({ tool_choice: 'none' });
    expect(calls[1].responseFormat).toBe('json');
  });

  test('ReAct: dead-loop prevention — need_more_investigation=true but no tool call injects user prompt', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDummyTool());

    const { gateway, getCalls } = createMockGateway([
      () => jsonResponse({ findings: [], need_more_investigation: true }),
      () => jsonResponse({ findings: [], need_more_investigation: false }),
    ]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs', registry);
    await agent.review(makeRun(), makeContext());

    const calls = getCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const secondCallMessages = calls[1].messages;
    const lastUserMsg = secondCallMessages.filter((m: any) => m.role === 'user').pop();
    expect(lastUserMsg).toBeDefined();
    if (!lastUserMsg) throw new Error('Expected user message in second call');
    expect(lastUserMsg.content).toContain('使用工具');
  });

  test('ReAct: fingerprint dedup across iterations — later finding with same fp overwrites', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDummyTool());

    const findingV1 = {
      severity: 'low' as const,
      confidence: 0.6,
      path: 'src/foo.ts',
      line: 1,
      title: 'Null issue',
      detail: 'First version',
      evidence: 'const x = null',
      suggestion: 'Fix v1',
      fingerprint: 'shared-fp-123',
    };

    const findingV2 = {
      ...findingV1,
      severity: 'high' as const,
      confidence: 0.95,
      detail: 'Second version - more confident',
      suggestion: 'Fix v2',
    };

    const { gateway } = createMockGateway([
      () => jsonResponse({ findings: [findingV1], need_more_investigation: true }),
      () => jsonResponse({ findings: [findingV2], need_more_investigation: false }),
    ]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs', registry);
    const result = await agent.review(makeRun(), makeContext());

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('high');
    expect(result.findings[0].confidence).toBe(0.95);
    expect(result.findings[0].detail).toBe('Second version - more confident');
  });

  test('ReAct: multiple unique fingerprints accumulate', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDummyTool());

    const finding1 = {
      severity: 'high' as const,
      confidence: 0.9,
      path: 'src/foo.ts',
      line: 1,
      title: 'Bug A',
      detail: 'Detail A',
      evidence: 'Evidence A',
      suggestion: 'Fix A',
      fingerprint: 'fp-aaa',
    };
    const finding2 = {
      severity: 'medium' as const,
      confidence: 0.8,
      path: 'src/bar.ts',
      line: 5,
      title: 'Bug B',
      detail: 'Detail B',
      evidence: 'Evidence B',
      suggestion: 'Fix B',
      fingerprint: 'fp-bbb',
    };

    const { gateway } = createMockGateway([
      () => jsonResponse({ findings: [finding1], need_more_investigation: true }),
      () => jsonResponse({ findings: [finding2], need_more_investigation: false }),
    ]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs', registry);
    const result = await agent.review(makeRun(), makeContext());

    expect(result.findings).toHaveLength(2);
    const fps = result.findings.map((f) => f.fingerprint);
    expect(fps).toContain('fp-aaa');
    expect(fps).toContain('fp-bbb');
  });

  test('ReAct: OpenAI error returns empty findings gracefully', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDummyTool());

    const { gateway } = createMockGateway([
      () => {
        throw new Error('API rate limited');
      },
    ]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs', registry);
    const result = await agent.review(makeRun(), makeContext());

    expect(result.findings).toHaveLength(0);
    expect(result.agentName).toBe('TestAgent');
  });

  test('ReAct: unknown tool call returns error result to model', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDummyTool('search_code'));

    const { gateway, getCalls } = createMockGateway([
      () => toolCallResponse([{ id: 'call_1', name: 'nonexistent_tool', args: {} }]),
      () => jsonResponse({ findings: [], need_more_investigation: false }),
    ]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs', registry);
    await agent.review(makeRun(), makeContext());

    const calls = getCalls();
    expect(calls).toHaveLength(2);
    const toolResultMsg = calls[1].messages.find(
      (m: any) => m.role === 'tool' && m.toolCallId === 'call_1'
    );
    expect(toolResultMsg).toBeTruthy();
    if (!toolResultMsg) throw new Error('Expected tool result message');
    const parsed = JSON.parse(toolResultMsg.content);
    expect(parsed.error).toContain('未找到');
  });

  test('ReAct: tool execution error is captured and returned to model', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...makeDummyTool(),
      execute: async () => {
        throw new Error('Sandbox timeout');
      },
    });

    const { gateway, getCalls } = createMockGateway([
      () => toolCallResponse([{ id: 'call_1', name: 'search_code', args: { query: 'x' } }]),
      () => jsonResponse({ findings: [], need_more_investigation: false }),
    ]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs', registry);
    await agent.review(makeRun(), makeContext());

    const calls = getCalls();
    const toolResultMsg = calls[1].messages.find(
      (m: any) => m.role === 'tool' && m.toolCallId === 'call_1'
    );
    expect(toolResultMsg).toBeTruthy();
    if (!toolResultMsg) throw new Error('Expected tool result message');
    const parsed = JSON.parse(toolResultMsg.content);
    expect(parsed.error).toContain('Sandbox timeout');
  });

  test('ReAct: empty choice content ends loop', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDummyTool());

    const { gateway } = createMockGateway([() => emptyResponse()]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs', registry);
    const result = await agent.review(makeRun(), makeContext());

    expect(result.findings).toHaveLength(0);
  });

  test('ReAct: malformed JSON response ends loop gracefully', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDummyTool());

    const { gateway } = createMockGateway([
      () => ({
        content: 'not valid json {{{',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
    ]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs', registry);
    const result = await agent.review(makeRun(), makeContext());

    expect(result.findings).toHaveLength(0);
  });

  test('staged context includes deleted lines metadata for review', async () => {
    const { gateway, getCalls } = createMockGateway([
      () =>
        jsonResponse({
          findings: [],
          need_more_investigation: false,
        }),
    ]);

    const context = makeContext({
      parsedDiff: [
        {
          path: 'src/foo.ts',
          changes: [
            { lineNumber: 12, oldLineNumber: 11, content: 'if (auth) {', type: 'context' },
            { lineNumber: 12, oldLineNumber: 12, content: 'if (isAdmin(user)) {', type: 'delete' },
            { lineNumber: 13, oldLineNumber: 13, content: 'return true;', type: 'add' },
          ],
        },
      ],
    });

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs');
    await agent.reviewWithOptions(makeRun(), context, {
      mode: 'full',
      allowTools: false,
      scopePaths: ['src/foo.ts'],
      maxContextTokens: 6000,
    });

    const calls = getCalls();
    expect(calls).toHaveLength(1);
    const userMessage = calls[0].messages.find((message) => message.role === 'user');
    expect(userMessage).toBeDefined();
    if (!userMessage) throw new Error('Expected user message in request');

    expect(userMessage.content).toContain('"type": "delete"');
    expect(userMessage.content).toContain('"oldLineNumber": 12');
  });

  test('review prompt guides autonomous cross-file investigation and durable CRUD checks', async () => {
    const { gateway, getCalls } = createMockGateway([
      () =>
        jsonResponse({
          findings: [],
          need_more_investigation: false,
        }),
    ]);

    const context = makeContext({
      changedFiles: [
        {
          path: 'components/business/SRv6/SRv6SlicePanel.vue',
          status: 'A',
          additions: 384,
          deletions: 0,
        },
        {
          path: 'components/business/SRv6/SRv6BasePlannerPanel.vue',
          status: 'A',
          additions: 746,
          deletions: 0,
        },
      ],
      parsedDiff: [
        {
          path: 'components/business/SRv6/SRv6SlicePanel.vue',
          changes: [
            { lineNumber: 231, content: 'const removeSliceAt = (index: number) => {', type: 'add' },
            { lineNumber: 232, content: '  slices.value.splice(index, 1)', type: 'add' },
          ],
        },
        {
          path: 'components/business/SRv6/SRv6BasePlannerPanel.vue',
          changes: [
            {
              lineNumber: 491,
              content: 'validateDeviceCodes(true, createPayloads.map(...))',
              type: 'add',
            },
          ],
        },
      ],
      fileContents: {
        'components/business/SRv6/SRv6SlicePanel.vue':
          'const removeSliceAt = (index: number) => {\n  slices.value.splice(index, 1)\n}',
        'components/business/SRv6/SRv6BasePlannerPanel.vue':
          'validateDeviceCodes(true, createPayloads.map((item) => item.device_uuid))',
      },
    });

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs');
    await agent.reviewWithOptions(makeRun(), context, {
      mode: 'full',
      allowTools: false,
      scopePaths: context.changedFiles.map((file) => file.path),
      maxContextTokens: 20000,
    });

    const userMessage = getCalls()[0].messages.find((message) => message.role === 'user');
    expect(userMessage).toBeDefined();
    if (!userMessage) throw new Error('Expected user message in request');

    expect(getCalls()).toHaveLength(1);
    expect(userMessage.content).toContain('调查地图，不是拆分任务');
    expect(userMessage.content).toContain('自主决定先读哪些文件');
    expect(userMessage.content).toContain('不要按文件孤立审查');
    expect(userMessage.content).toContain('components/business/SRv6/SRv6SlicePanel.vue');
    expect(userMessage.content).toContain('components/business/SRv6/SRv6BasePlannerPanel.vue');
    expect(userMessage.content).toContain('真正调用后端 API 持久化');
    expect(userMessage.content).toContain('只修改前端数组或临时状态');
  });

  test('ReAct regression: can report kuiper-web slice deletion that only mutates local array', async () => {
    const registry = new ToolRegistry();
    const readFile = mock(async () => ({
      path: 'components/business/SRv6/SRv6SlicePanel.vue',
      content:
        'const removeSliceAt = (index: number) => {\n  slices.value.splice(index, 1)\n  if (activeSliceIndex.value === index) {\n    activeSliceIndex.value = -1\n  }\n}',
      totalLines: 384,
    }));
    registry.register({ ...makeDummyTool('read_file'), execute: readFile });

    const finding = {
      severity: 'high' as const,
      confidence: 0.92,
      path: 'components/business/SRv6/SRv6SlicePanel.vue',
      line: 232,
      title: 'Flex 切片删除未持久化',
      detail:
        '删除操作只执行 slices.value.splice(index, 1)，没有调用后端删除接口，刷新后切片会恢复。',
      evidence: 'slices.value.splice(index, 1)',
      suggestion: '删除已持久化切片时调用 /network-slices 对应 DELETE 接口，成功后再刷新列表。',
    };

    const { gateway, getCalls } = createMockGateway([
      () =>
        toolCallResponse([
          {
            id: 'call_1',
            name: 'read_file',
            args: {
              file_path: 'components/business/SRv6/SRv6SlicePanel.vue',
              start_line: 220,
              end_line: 240,
            },
          },
        ]),
      () => jsonResponse({ findings: [finding], need_more_investigation: false }),
    ]);

    const context = makeContext({
      changedFiles: [
        {
          path: 'components/business/SRv6/SRv6SlicePanel.vue',
          status: 'A',
          additions: 384,
          deletions: 0,
        },
      ],
      parsedDiff: [
        {
          path: 'components/business/SRv6/SRv6SlicePanel.vue',
          changes: [
            { lineNumber: 231, content: 'const removeSliceAt = (index: number) => {', type: 'add' },
            { lineNumber: 232, content: '  slices.value.splice(index, 1)', type: 'add' },
          ],
        },
      ],
      fileContents: {
        'components/business/SRv6/SRv6SlicePanel.vue':
          'const removeSliceAt = (index: number) => {\n  slices.value.splice(index, 1)\n}',
      },
    });

    const agent = new SpecialistAgent(
      gateway as any,
      'quality',
      'Quality Agent',
      '错误处理、持久化、可维护性',
      registry
    );
    const result = await agent.reviewWithOptions(makeRun(), context, {
      mode: 'full',
      allowTools: true,
      maxIterations: 4,
      scopePaths: ['components/business/SRv6/SRv6SlicePanel.vue'],
    });

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(getCalls()).toHaveLength(2);
    expect(getCalls()[0].providerOptions).toEqual({
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    });
    expect(getCalls()[1].providerOptions).toEqual({ tool_choice: 'none' });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      category: 'quality',
      path: 'components/business/SRv6/SRv6SlicePanel.vue',
      line: 232,
      title: 'Flex 切片删除未持久化',
    });
    expect(result.diagnostics).toMatchObject({
      iterations: 2,
      parsedFindingCount: 1,
      toolCallNames: ['read_file'],
      forcedToolChoiceCount: 1,
    });
  });

  test('full mode challenges empty findings until the agent reads file content', async () => {
    const registry = new ToolRegistry();
    const readFile = mock(async () => ({
      path: 'src/feature.ts',
      content: 'export function removeItem(index: number) { items.splice(index, 1) }',
      totalLines: 1,
    }));
    registry.register(makeDummyTool('search_code'));
    registry.register({ ...makeDummyTool('read_file'), execute: readFile });

    const { gateway, getCalls } = createMockGateway([
      () => jsonResponse({ findings: [], need_more_investigation: false }),
      () =>
        toolCallResponse([
          {
            id: 'call_1',
            name: 'read_file',
            args: { file_path: 'src/feature.ts', start_line: 1, end_line: 40 },
          },
        ]),
      () => jsonResponse({ findings: [], need_more_investigation: false }),
    ]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs', registry);
    const result = await agent.reviewWithOptions(makeRun(), makeContext(), {
      mode: 'full',
      allowTools: true,
      maxIterations: 2,
      scopePaths: ['src/feature.ts'],
    });

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(getCalls()).toHaveLength(3);
    expect(getCalls()[0].providerOptions).toEqual({
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    });
    expect(getCalls()[1].providerOptions).toEqual({
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    });
    expect(getCalls()[2].providerOptions).toEqual({ tool_choice: 'none' });
    const secondCallUserMessage = getCalls()[1]
      .messages.filter((message) => message.role === 'user')
      .pop();
    expect(secondCallUserMessage?.content).toContain('还没有读取任何文件内容');
    expect(result.findings).toHaveLength(0);
    expect(result.diagnostics).toMatchObject({
      iterations: 3,
      toolCallNames: ['read_file'],
      parsedFindingCount: 0,
      forcedToolChoiceCount: 2,
    });
  });

  test('full mode does not accept findings before reading file content', async () => {
    const registry = new ToolRegistry();
    const readFile = mock(async () => ({
      path: 'src/feature.ts',
      content: 'export function save() { return api.save() }',
      totalLines: 1,
    }));
    registry.register({ ...makeDummyTool('read_file'), execute: readFile });

    const prematureFinding = {
      severity: 'high' as const,
      confidence: 0.9,
      path: 'src/feature.ts',
      line: 1,
      title: 'Premature finding',
      detail: 'This should not be accepted before reading file content',
      evidence: 'diff only',
      suggestion: 'Read the file first',
    };
    const finalFinding = {
      ...prematureFinding,
      title: 'Evidence-backed finding',
      evidence: 'export function save() { return api.save() }',
    };

    const { gateway, getCalls } = createMockGateway([
      () => jsonResponse({ findings: [prematureFinding], need_more_investigation: false }),
      () =>
        toolCallResponse([
          {
            id: 'call_1',
            name: 'read_file',
            args: { file_path: 'src/feature.ts', start_line: 1, end_line: 40 },
          },
        ]),
      () => jsonResponse({ findings: [finalFinding], need_more_investigation: false }),
    ]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs', registry);
    const result = await agent.reviewWithOptions(makeRun(), makeContext(), {
      mode: 'full',
      allowTools: true,
      maxIterations: 2,
      scopePaths: ['src/feature.ts'],
    });

    expect(readFile).toHaveBeenCalledTimes(1);
    expect(getCalls()).toHaveLength(3);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe('Evidence-backed finding');
    expect(result.findings[0].evidence).toBe('export function save() { return api.save() }');
    expect(result.diagnostics).toMatchObject({
      iterations: 3,
      parsedFindingCount: 1,
      toolCallNames: ['read_file'],
    });
  });

  test('ReAct: auto-generates fingerprint when finding has none', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDummyTool());

    const finding = {
      severity: 'high' as const,
      confidence: 0.9,
      path: 'src/foo.ts',
      line: 1,
      title: 'Missing null check',
      detail: 'Detail',
      evidence: 'Evidence',
      suggestion: 'Add check',
    };

    const { gateway } = createMockGateway([
      () => jsonResponse({ findings: [finding], need_more_investigation: false }),
    ]);

    const agent = new SpecialistAgent(gateway as any, category, 'TestAgent', 'bugs', registry);
    const result = await agent.review(makeRun(), makeContext());

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].fingerprint).toBeTruthy();
    expect(result.findings[0].fingerprint.length).toBeGreaterThan(0);
  });
});
