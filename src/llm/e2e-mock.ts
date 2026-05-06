import { llmGateway } from './gateway';
import type { LLMChatRequest, LLMChatResponse, ModelRole } from './types';

type ChatForRoleFn = (
  role: ModelRole,
  request: Omit<LLMChatRequest, 'model'>
) => Promise<LLMChatResponse>;

interface MockResponseConfig {
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

const MOCK_RESPONSES: Record<string, MockResponseConfig> = {
  specialist: {
    content: JSON.stringify({
      findings: [
        {
          severity: 'high',
          confidence: 0.95,
          path: 'src/user-handler.ts',
          line: 3,
          title: 'Missing null check on input parameter',
          detail:
            'The input parameter is not validated before accessing input.userId. This will throw a TypeError when input is null or undefined.',
          evidence: 'const userId = input.userId;',
          suggestion: 'Add a null/undefined guard: if (!input) return null;',
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
  embedding: {
    content: '',
    usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
  },
  judge: {
    content: JSON.stringify({
      decision: 'request_changes',
      rationale: 'High-severity findings require fixes before merge.',
    }),
    usage: { promptTokens: 300, completionTokens: 100, totalTokens: 400 },
  },
};

export function createMockChatForRole(): ChatForRoleFn {
  return async (role, _request) => {
    const config = MOCK_RESPONSES[role] ?? MOCK_RESPONSES.specialist;
    return {
      content: config.content,
      toolCalls: [],
      finishReason: 'stop',
      usage: config.usage,
    };
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
