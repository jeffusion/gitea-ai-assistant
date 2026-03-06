import { Hono } from 'hono';
import { logger } from '../../utils/logger';
import { MCP_TOOLS, mcpToolExecutor } from './mcp-tools';

/**
 * Streamable HTTP MCP handler
 *
 * Codex 通过 StreamableHttp transport 发送标准 JSON-RPC 2.0 请求。
 * 我们实现最小子集：initialize、tools/list、tools/call。
 *
 * 路由挂载到 /mcp/gitea-review
 */

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function jsonRpcResponse(id: string | number | null, result: unknown) {
  return {
    jsonrpc: '2.0' as const,
    id,
    result,
  };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: { code, message },
  };
}

const SERVER_INFO = {
  name: 'gitea-review',
  version: '1.0.0',
};

const SERVER_CAPABILITIES = {
  tools: {},
};

export const mcpRouter = new Hono();

/**
 * POST /mcp/gitea-review — 处理所有 MCP JSON-RPC 请求
 *
 * Codex StreamableHttp transport 通过 POST 发送 JSON-RPC，
 * 通过 X-Review-Run-Id header 区分审查会话。
 */
mcpRouter.post('/', async (c) => {
  const runId = c.req.header('X-Review-Run-Id') || '';

  let body: JsonRpcMessage | JsonRpcMessage[];
  try {
    body = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, -32700, 'Parse error'), 400);
  }

  const messages = Array.isArray(body) ? body : [body];

  // 按 MCP Streamable HTTP 规范：
  // - 通知（没有 id）不期待响应
  // - 如果所有消息都是通知，返回 202 Accepted 空 body
  // - 如果包含请求（有 id），返回对应响应
  const requests: JsonRpcMessage[] = [];
  const notifications: JsonRpcMessage[] = [];

  for (const msg of messages) {
    if (msg.id !== undefined && msg.id !== null) {
      requests.push(msg);
    } else {
      notifications.push(msg);
    }
  }

  // 处理通知（仅日志，不返回响应）
  for (const notif of notifications) {
    handleNotification(runId, notif);
  }

  // 如果没有需要响应的请求，返回 202 Accepted
  if (requests.length === 0) {
    return c.body(null, 202);
  }

  // 处理请求
  const results = await Promise.all(requests.map((req) => handleRequest(runId, req)));

  // 单个请求返回单个对象，批量返回数组
  if (!Array.isArray(body)) {
    return c.json(results[0]);
  }
  return c.json(results);
});

/**
 * GET /mcp/gitea-review — SSE 端点（Streamable HTTP MCP 的 server-initiated 通道）
 *
 * Codex 在连接时会先 GET 此端点建立 SSE 连接。
 * 我们的 MCP server 不需要主动推送，所以保持连接存活即可。
 */
mcpRouter.get('/', (c) => {
  // 返回 SSE 流，保持连接（Codex 需要此端点存在）
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  // 发送一个空的 SSE 注释保持连接
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
        // 不关闭 — Codex 会自行断开
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    }
  );
});

/**
 * DELETE /mcp/gitea-review — 会话结束信号
 */
mcpRouter.delete('/', (c) => {
  return c.json({ ok: true });
});

/** 处理 JSON-RPC 通知（无 id，不返回响应） */
function handleNotification(runId: string, notif: JsonRpcMessage): void {
  logger.debug('MCP JSON-RPC 通知', { method: notif.method, runId });
  // notifications/initialized 等通知仅记录日志，无需其他处理
}

/** 处理 JSON-RPC 请求（有 id，需要返回响应） */
async function handleRequest(runId: string, req: JsonRpcMessage) {
  if (!req.jsonrpc || req.jsonrpc !== '2.0') {
    return jsonRpcError(req.id ?? null, -32600, 'Invalid Request: not JSON-RPC 2.0');
  }

  logger.debug('MCP JSON-RPC 请求', { method: req.method, runId, id: req.id });

  switch (req.method) {
    case 'initialize':
      return jsonRpcResponse(req.id!, {
        protocolVersion: '2025-03-26',
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
      });

    case 'tools/list':
      return jsonRpcResponse(req.id!, {
        tools: MCP_TOOLS,
      });

    case 'tools/call': {
      const params = req.params as
        | { name: string; arguments?: Record<string, unknown> }
        | undefined;
      if (!params?.name) {
        return jsonRpcError(req.id!, -32602, 'Invalid params: missing tool name');
      }

      if (!runId) {
        return jsonRpcError(req.id!, -32602, 'Missing X-Review-Run-Id header');
      }

      const result = await mcpToolExecutor.callTool(runId, params.name, params.arguments || {});
      return jsonRpcResponse(req.id!, result);
    }

    case 'ping':
      return jsonRpcResponse(req.id!, {});

    default:
      return jsonRpcError(req.id!, -32601, `Method not found: ${req.method}`);
  }
}
