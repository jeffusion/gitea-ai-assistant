import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { FileReviewStore } from '../../store/file-review-store';

type MockGiteaService = {
  addPullRequestComment: ReturnType<
    typeof mock<(owner: string, repo: string, prNumber: number, body: string) => Promise<void>>
  >;
  addCommitComment: ReturnType<
    typeof mock<(owner: string, repo: string, commitSha: string, body: string) => Promise<void>>
  >;
  addLineComments: ReturnType<
    typeof mock<
      (
        owner: string,
        repo: string,
        prNumber: number,
        commitId: string,
        comments: Array<{ path: string; line: number; comment: string }>
      ) => Promise<void>
    >
  >;
  getRelatedPullRequest: ReturnType<
    typeof mock<
      (owner: string, repo: string, commitSha: string) => Promise<{ number: number } | null>
    >
  >;
};

function createMockGiteaService(): MockGiteaService {
  return {
    addPullRequestComment: mock(async () => {}),
    addCommitComment: mock(async () => {}),
    addLineComments: mock(async () => {}),
    getRelatedPullRequest: mock(async () => null),
  };
}

function setupGiteaModuleMock(mockGiteaService: MockGiteaService): void {
  mock.module('../../../services/gitea', () => ({
    giteaService: mockGiteaService,
  }));
}

class TestStore extends FileReviewStore {
  constructor() {
    super('/tmp/mcp-tool-executor-test-store');
  }
}

describe('McpToolExecutor', () => {
  let mockGiteaService: MockGiteaService;

  beforeEach(() => {
    mockGiteaService = createMockGiteaService();
    setupGiteaModuleMock(mockGiteaService);
  });

  afterEach(() => {
    mock.restore();
  });

  test('registerContext / unregisterContext / getContext works as CRUD', async () => {
    const { McpToolExecutor } = await import('../mcp-tools');
    const executor = new McpToolExecutor();

    const context = {
      runId: 'run-1',
      owner: 'octo',
      repo: 'demo',
      prNumber: 42,
      baseSha: 'base-sha',
      headSha: 'head-sha',
    };

    executor.registerContext(context);
    expect(executor.getContext('run-1')).toEqual(context);

    executor.unregisterContext('run-1');
    expect(executor.getContext('run-1')).toBeUndefined();
  });

  test('callTool(get_pr_info) returns full review mode when no lastReviewedHead', async () => {
    const { McpToolExecutor } = await import('../mcp-tools');
    const executor = new McpToolExecutor();

    executor.registerContext({
      runId: 'run-full',
      owner: 'octo',
      repo: 'demo',
      prNumber: 7,
      baseSha: 'base-1',
      headSha: 'head-1',
    });

    const result = await executor.callTool('run-full', 'get_pr_info', {});
    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(parsed.owner).toBe('octo');
    expect(parsed.repo).toBe('demo');
    expect(parsed.prNumber).toBe(7);
    expect(parsed.baseSha).toBe('base-1');
    expect(parsed.headSha).toBe('head-1');
    expect(parsed.commitSha).toBe('head-1');
    expect(parsed.reviewMode).toBe('full');
    expect(parsed.lastReviewedHead).toBeUndefined();
  });

  test('callTool(get_pr_info) returns incremental review mode with lastReviewedHead', async () => {
    const { McpToolExecutor } = await import('../mcp-tools');
    const executor = new McpToolExecutor();

    executor.registerContext({
      runId: 'run-incremental',
      owner: 'octo',
      repo: 'demo',
      prNumber: 9,
      baseSha: 'base-2',
      headSha: 'head-2',
      lastReviewedHead: 'head-1',
    });

    const result = await executor.callTool('run-incremental', 'get_pr_info', {});
    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(result.isError).toBeUndefined();
    expect(parsed.reviewMode).toBe('incremental');
    expect(parsed.lastReviewedHead).toBe('head-1');
  });

  test('callTool(unknown_tool) returns error', async () => {
    const { McpToolExecutor } = await import('../mcp-tools');
    const executor = new McpToolExecutor();

    executor.registerContext({
      runId: 'run-unknown',
      owner: 'octo',
      repo: 'demo',
    });

    const result = await executor.callTool('run-unknown', 'unknown_tool', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('未知工具');
  });

  test('callTool with non-existent runId returns context-not-found error', async () => {
    const { McpToolExecutor } = await import('../mcp-tools');
    const executor = new McpToolExecutor();

    const result = await executor.callTool('missing-run', 'get_pr_info', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('找不到审查上下文');
    expect(result.content[0].text).toContain('missing-run');
  });

  test('callTool(add_review_summary) calls giteaService and persists comment record', async () => {
    const { McpToolExecutor } = await import('../mcp-tools');
    const store = new TestStore();
    const addCommentRecordSpy = spyOn(store, 'addCommentRecord').mockResolvedValue();
    const executor = new McpToolExecutor(store);

    executor.registerContext({
      runId: 'run-summary',
      owner: 'octo',
      repo: 'demo',
      prNumber: 88,
      headSha: 'head-summary',
    });

    const result = await executor.callTool('run-summary', 'add_review_summary', {
      summary: 'Looks good overall.',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('审查总结已发布成功');
    expect(mockGiteaService.addPullRequestComment).toHaveBeenCalledTimes(1);
    expect(mockGiteaService.addPullRequestComment).toHaveBeenCalledWith(
      'octo',
      'demo',
      88,
      expect.stringContaining('Looks good overall.')
    );
    expect(addCommentRecordSpy).toHaveBeenCalledTimes(1);
    expect(addCommentRecordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-summary',
        status: 'published',
      })
    );
  });

  test('callTool(add_line_comment) calls giteaService and persists comment record', async () => {
    const { McpToolExecutor } = await import('../mcp-tools');
    const store = new TestStore();
    const addCommentRecordSpy = spyOn(store, 'addCommentRecord').mockResolvedValue();
    const executor = new McpToolExecutor(store);

    executor.registerContext({
      runId: 'run-line',
      owner: 'octo',
      repo: 'demo',
      prNumber: 11,
      headSha: 'head-line',
    });

    const result = await executor.callTool('run-line', 'add_line_comment', {
      path: 'src/app.ts',
      line: 23,
      comment: 'Potential null pointer here.',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('行评论已添加');
    expect(mockGiteaService.addLineComments).toHaveBeenCalledTimes(1);
    expect(mockGiteaService.addLineComments).toHaveBeenCalledWith('octo', 'demo', 11, 'head-line', [
      { path: 'src/app.ts', line: 23, comment: 'Potential null pointer here.' },
    ]);
    expect(addCommentRecordSpy).toHaveBeenCalledTimes(1);
    expect(addCommentRecordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-line',
        status: 'published',
        path: 'src/app.ts',
        line: 23,
      })
    );
  });
});

describe('mcpRouter JSON-RPC', () => {
  afterEach(() => {
    mock.restore();
  });

  test('initialize returns protocol and server info', async () => {
    const callTool = mock(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    mock.module('../mcp-tools', () => ({
      MCP_TOOLS: [{ name: 'get_pr_info', description: 'desc', inputSchema: { type: 'object' } }],
      mcpToolExecutor: { callTool },
    }));
    const { mcpRouter } = await import('../mcp-handler');

    const response = await mcpRouter.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Review-Run-Id': 'run-init' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const data = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result: { protocolVersion: string; serverInfo: { name: string; version: string } };
    };

    expect(response.status).toBe(200);
    expect(data.jsonrpc).toBe('2.0');
    expect(data.id).toBe(1);
    expect(data.result.protocolVersion).toBe('2025-03-26');
    expect(data.result.serverInfo.name).toBe('gitea-review');
    expect(callTool).not.toHaveBeenCalled();
  });

  test('tools/list returns tools', async () => {
    const callTool = mock(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    mock.module('../mcp-tools', () => ({
      MCP_TOOLS: [
        { name: 'add_review_summary', description: 'desc', inputSchema: { type: 'object' } },
      ],
      mcpToolExecutor: { callTool },
    }));
    const { mcpRouter } = await import('../mcp-handler');

    const response = await mcpRouter.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Review-Run-Id': 'run-list' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const data = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };

    expect(response.status).toBe(200);
    expect(data.result.tools).toHaveLength(1);
    expect(data.result.tools[0].name).toBe('add_review_summary');
  });

  test('tools/call dispatches to mcpToolExecutor', async () => {
    const toolResult = { content: [{ type: 'text', text: 'tool-ok' }] };
    const callTool = mock(async () => toolResult);
    mock.module('../mcp-tools', () => ({
      MCP_TOOLS: [],
      mcpToolExecutor: { callTool },
    }));
    const { mcpRouter } = await import('../mcp-handler');

    const response = await mcpRouter.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Review-Run-Id': 'run-call' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_pr_info', arguments: { verbose: true } },
      }),
    });
    const data = (await response.json()) as { result: { content: Array<{ text: string }> } };

    expect(response.status).toBe(200);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('run-call', 'get_pr_info', { verbose: true });
    expect(data.result.content[0].text).toBe('tool-ok');
  });

  test('notification-only batch returns 202', async () => {
    const callTool = mock(async () => ({ content: [{ type: 'text', text: 'tool-ok' }] }));
    mock.module('../mcp-tools', () => ({
      MCP_TOOLS: [],
      mcpToolExecutor: { callTool },
    }));
    const { mcpRouter } = await import('../mcp-handler');

    const response = await mcpRouter.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Review-Run-Id': 'run-notif' },
      body: JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }]),
    });

    expect(response.status).toBe(202);
    expect(callTool).not.toHaveBeenCalled();
  });

  test('invalid JSON returns parse error', async () => {
    const callTool = mock(async () => ({ content: [{ type: 'text', text: 'tool-ok' }] }));
    mock.module('../mcp-tools', () => ({
      MCP_TOOLS: [],
      mcpToolExecutor: { callTool },
    }));
    const { mcpRouter } = await import('../mcp-handler');

    const response = await mcpRouter.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Review-Run-Id': 'run-parse' },
      body: '{not-json',
    });
    const data = (await response.json()) as { error: { code: number; message: string } };

    expect(response.status).toBe(400);
    expect(data.error.code).toBe(-32700);
    expect(data.error.message).toBe('Parse error');
  });

  test('tools/call without runId header returns invalid params error', async () => {
    const callTool = mock(async () => ({ content: [{ type: 'text', text: 'tool-ok' }] }));
    mock.module('../mcp-tools', () => ({
      MCP_TOOLS: [],
      mcpToolExecutor: { callTool },
    }));
    const { mcpRouter } = await import('../mcp-handler');

    const response = await mcpRouter.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_pr_info', arguments: {} },
      }),
    });
    const data = (await response.json()) as { error: { code: number; message: string } };

    expect(response.status).toBe(200);
    expect(data.error.code).toBe(-32602);
    expect(data.error.message).toContain('Missing X-Review-Run-Id header');
    expect(callTool).not.toHaveBeenCalled();
  });

  test('unknown method returns method-not-found error', async () => {
    const callTool = mock(async () => ({ content: [{ type: 'text', text: 'tool-ok' }] }));
    mock.module('../mcp-tools', () => ({
      MCP_TOOLS: [],
      mcpToolExecutor: { callTool },
    }));
    const { mcpRouter } = await import('../mcp-handler');

    const response = await mcpRouter.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Review-Run-Id': 'run-missing-method' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'no_such_method' }),
    });
    const data = (await response.json()) as { error: { code: number; message: string } };

    expect(response.status).toBe(200);
    expect(data.error.code).toBe(-32601);
    expect(data.error.message).toContain('Method not found');
  });
});
