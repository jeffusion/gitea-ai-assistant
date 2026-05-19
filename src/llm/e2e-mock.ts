import { llmGateway } from './gateway';
import type { LLMChatRequest, LLMChatResponse, LLMToolCall, ModelRole } from './types';

type ChatForRoleFn = (
  role: ModelRole,
  request: Omit<LLMChatRequest, 'model'>
) => Promise<LLMChatResponse>;

interface MockResponseConfig {
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

const MOCK_RESPONSES: Record<ModelRole, MockResponseConfig> = {
  specialist: {
    content: JSON.stringify({
      findings: [
        {
          severity: 'high',
          confidence: 0.96,
          path: 'src/user-handler.ts',
          line: 16,
          title: 'Caller dereferences nullable user profile fields',
          detail:
            'getUserDisplayName accepts UserRecord | null but dereferences user.profile!.displayName! without guarding null or missing profile data. The companion auth/user model shows callers can pass absent users.',
          evidence:
            'src/user-handler.ts: return user.profile!.displayName!.toUpperCase(); src/auth.ts: authenticate(...) returns User | null',
          suggestion:
            'Return a safe fallback when user/profile/displayName is missing, or reject null before calling getUserDisplayName.',
        },
        {
          severity: 'medium',
          confidence: 0.85,
          path: 'src/user-handler.ts',
          line: 6,
          title: 'SQL injection via string interpolation',
          detail:
            'userId is interpolated directly into the SQL query string, allowing an attacker to inject arbitrary SQL.',
          evidence: "const query = `SELECT * FROM users WHERE id = '${userId}'`;",
          suggestion: 'Use parameterized queries instead of string interpolation.',
        },
      ],
    }),
    usage: { promptTokens: 1200, completionTokens: 800, totalTokens: 2000 },
  },
  planner: {
    content: JSON.stringify({
      summary:
        'The diff contains a new user-handler module with null safety and SQL injection issues.',
      keyConcerns: ['Missing null check', 'SQL injection risk'],
      recommendation: 'Require changes before merging.',
    }),
    usage: { promptTokens: 500, completionTokens: 200, totalTokens: 700 },
  },
};

function toolCall(id: string, name: string, args: Record<string, unknown>): LLMToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function toolCallResponse(toolCalls: LLMToolCall[]): LLMChatResponse {
  return {
    content: null,
    toolCalls,
    finishReason: 'tool_calls',
    usage: { promptTokens: 300, completionTokens: 60, totalTokens: 360 },
  };
}

function stopResponse(config: MockResponseConfig): LLMChatResponse {
  return {
    content: config.content,
    toolCalls: [],
    finishReason: 'stop',
    usage: config.usage,
  };
}

function createAutonomousSpecialistResponse(
  request: Omit<LLMChatRequest, 'model'>
): LLMChatResponse {
  const toolResultCount = request.messages.filter((message) => message.role === 'tool').length;

  if (toolResultCount === 0) {
    return toolCallResponse([
      toolCall('e2e_search_user_handler', 'search_code', {
        pattern: 'getUserDisplayName|authenticate|findUserByEmail',
        file_types: ['ts'],
        max_results: 20,
      }),
    ]);
  }

  if (toolResultCount === 1) {
    return toolCallResponse([
      toolCall('e2e_read_caller', 'read_file', { file_path: 'src/user-handler.ts' }),
    ]);
  }

  if (toolResultCount === 2) {
    return toolCallResponse([
      toolCall('e2e_read_callee', 'read_file', { file_path: 'src/auth.ts' }),
    ]);
  }

  return stopResponse(MOCK_RESPONSES.specialist);
}

export function createMockChatForRole(): ChatForRoleFn {
  return async (role, request) => {
    if (role === 'specialist' && request.tools?.length) {
      return createAutonomousSpecialistResponse(request);
    }

    const config = MOCK_RESPONSES[role];
    return stopResponse(config);
  };
}

export function isE2EMockActive(): boolean {
  return process.env.E2E_MOCK_LLM === '1';
}

export function installE2EMockLLMGateway(): void {
  if (!isE2EMockActive()) return;
  console.log('[E2E] LLM mock active — all chatForRole calls return preset responses');
  llmGateway.chatForRole = createMockChatForRole() as typeof llmGateway.chatForRole;
}
