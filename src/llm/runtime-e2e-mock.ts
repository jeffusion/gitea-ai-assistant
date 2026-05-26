import type { MainAgentModelClient } from '../agent-kernel/loop';
import type { LLMChatRequest, LLMChatResponse, LLMToolCall } from './types';

const DEFAULT_USAGE = {
  promptTokens: 8,
  completionTokens: 8,
  totalTokens: 16,
} as const;

function hasTool(request: LLMChatRequest, name: string): boolean {
  return (request.tools ?? []).some((tool) => tool.name === name);
}

function toolResultNames(request: LLMChatRequest): string[] {
  const toolNameById = new Map<string, string>();
  const completed: string[] = [];

  for (const message of request.messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        toolNameById.set(call.id, call.name);
      }
      continue;
    }

    if (message.role !== 'tool' || !message.toolCallId) {
      continue;
    }

    try {
      JSON.parse(message.content);
    } catch {
      continue;
    }

    const toolName = toolNameById.get(message.toolCallId);
    if (toolName) {
      completed.push(toolName);
    }
  }

  return completed;
}

function toolCall(id: string, name: string, args: Record<string, unknown>): LLMToolCall {
  return {
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function response(content: string | null, toolCalls: LLMToolCall[] = []): LLMChatResponse {
  return {
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage: DEFAULT_USAGE,
  };
}

export class RuntimeE2EMockLLM implements MainAgentModelClient {
  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const isMain = hasTool(request, 'spawn_subagent') && hasTool(request, 'submit_review_findings');
    const names = toolResultNames(request);

    if (isMain) {
      if (!names.includes('read_file')) {
        return response(null, [
          toolCall('main-read-file', 'read_file', { path: 'src/user-handler.ts' }),
        ]);
      }
      if (!names.includes('spawn_subagent')) {
        return response(null, [
          toolCall('main-spawn-subagent', 'spawn_subagent', {
            description: '检查高风险模式并提供证据',
            prompt: '请先搜索再读取目标文件，确认是否存在高风险问题并给出简短结论。',
          }),
        ]);
      }
      if (!names.includes('submit_review_findings')) {
        return response(null, [
          toolCall('main-submit-findings', 'submit_review_findings', {
            summaryMarkdown: '发现高风险安全问题，建议阻断合并并修复。',
            findings: [
              {
                fingerprint: 'security:src/user-handler.ts:107:avoid-eval',
                category: 'security',
                severity: 'high',
                confidence: 0.95,
                path: 'src/user-handler.ts',
                line: 107,
                title: '不安全的动态代码执行',
                detail: '直接对外部输入执行 eval 可能导致远程代码执行。',
                evidence: 'const config = eval(input.config);',
                suggestion: '移除 eval，改用白名单解析器或结构化配置。',
              },
            ],
          }),
        ]);
      }
      return response('E2E mock review completed.');
    }

    if (!names.includes('search_code')) {
      return response(null, [
        toolCall('sub-search-code', 'search_code', { query: 'eval(', maxResults: 5 }),
      ]);
    }
    if (!names.includes('read_file')) {
      return response(null, [
        toolCall('sub-read-file', 'read_file', { path: 'src/user-handler.ts' }),
      ]);
    }
    return response('子代理确认发现高风险 eval 用法。');
  }
}
