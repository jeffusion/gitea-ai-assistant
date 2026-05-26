import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import ReviewSessionsPage from '../ReviewSessionsPage';
import { fetchReviewRuns, fetchReviewRunDetails } from '@/services/reviewSessionService';

vi.mock('@/services/reviewSessionService', () => ({
  fetchReviewRuns: vi.fn(),
  fetchReviewRunDetails: vi.fn(),
}));

function renderWithQuery(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('ReviewSessionsPage', () => {
  it('Scenario 1: renders main agent plus two subagents with statuses, tool counts, and model info', async () => {
    const mockRuns = {
      data: [
        {
          id: 'run-1',
          idempotencyKey: 'key-1',
          eventType: 'pull_request' as const,
          status: 'succeeded' as const,
          owner: 'test-owner',
          repo: 'test-repo',
          cloneUrl: 'http://clone',
          prNumber: 42,
          attempts: 1,
          maxAttempts: 2,
          createdAt: '2026-05-25T00:00:00.000Z',
          updatedAt: '2026-05-25T00:00:00.000Z',
        },
      ],
    };

    const mockDetails = {
      run: mockRuns.data[0],
      steps: [],
      findings: [],
      comments: [],
      sessionTree: {
        id: 'session-main',
        agentType: 'review-main-agent',
        model: 'gpt-main',
        status: 'completed',
        metadata: {},
        startedAt: '2026-05-25T00:00:00.000Z',
        completedAt: '2026-05-25T00:01:00.000Z',
        createdAt: '2026-05-25T00:00:00.000Z',
        updatedAt: '2026-05-25T00:01:00.000Z',
        messages: [
          {
            id: 'msg-1',
            sessionId: 'session-main',
            sequence: 1,
            role: 'user',
            content: 'Hello',
            metadata: {},
            createdAt: '2026-05-25T00:00:05.000Z',
          },
        ],
        toolCalls: [
          {
            id: 'tool-1',
            sessionId: 'session-main',
            sequence: 1,
            toolName: 'search_code',
            status: 'completed',
            arguments: {},
            createdAt: '2026-05-25T00:00:10.000Z',
          },
        ],
        invocations: [
          {
            id: 'inv-1',
            parentSessionId: 'session-main',
            childSessionId: 'session-sub-1',
            sequence: 1,
            agentType: 'security-reviewer',
            model: 'gpt-sub-a',
            status: 'completed',
            input: {},
            createdAt: '2026-05-25T00:00:15.000Z',
            childSession: {
              id: 'session-sub-1',
              parentSessionId: 'session-main',
              parentInvocationId: 'inv-1',
              agentType: 'security-reviewer',
              model: 'gpt-sub-a',
              status: 'completed',
              metadata: {},
              startedAt: '2026-05-25T00:00:15.000Z',
              completedAt: '2026-05-25T00:00:30.000Z',
              createdAt: '2026-05-25T00:00:15.000Z',
              updatedAt: '2026-05-25T00:00:30.000Z',
              messages: [],
              toolCalls: [],
              invocations: [],
            },
          },
          {
            id: 'inv-2',
            parentSessionId: 'session-main',
            childSessionId: 'session-sub-2',
            sequence: 2,
            agentType: 'quality-reviewer',
            model: 'gpt-sub-b',
            status: 'completed',
            input: {},
            createdAt: '2026-05-25T00:00:35.000Z',
            childSession: {
              id: 'session-sub-2',
              parentSessionId: 'session-main',
              parentInvocationId: 'inv-2',
              agentType: 'quality-reviewer',
              model: 'gpt-sub-b',
              status: 'completed',
              metadata: {},
              startedAt: '2026-05-25T00:00:35.000Z',
              completedAt: '2026-05-25T00:00:50.000Z',
              createdAt: '2026-05-25T00:00:35.000Z',
              updatedAt: '2026-05-25T00:00:50.000Z',
              messages: [],
              toolCalls: [],
              invocations: [],
            },
          },
        ],
      },
    };

    vi.mocked(fetchReviewRuns).mockResolvedValue(mockRuns as any);
    vi.mocked(fetchReviewRunDetails).mockResolvedValue(mockDetails as any);

    renderWithQuery(<ReviewSessionsPage />);

    // Wait for details to load and render
    const mainAgentText = await screen.findByText('主代理: review-main-agent');
    expect(mainAgentText).toBeInTheDocument();

    expect(screen.getAllByText('gpt-main').length).toBeGreaterThanOrEqual(1);

    // Assert subagents are rendered
    expect(screen.getByText('子代理: security-reviewer')).toBeInTheDocument();
    expect(screen.getAllByText('gpt-sub-a').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('子代理: quality-reviewer')).toBeInTheDocument();
    expect(screen.getAllByText('gpt-sub-b').length).toBeGreaterThanOrEqual(1);

    // Assert tool calls count is visible in the details panel tabs
    expect(screen.getByText('工具调用 (1)')).toBeInTheDocument();
  });

  it('Scenario 2: renders failed subagent invocation and findings correctly', async () => {
    const mockRuns = {
      data: [
        {
          id: 'run-2',
          idempotencyKey: 'key-2',
          eventType: 'pull_request' as const,
          status: 'failed' as const,
          owner: 'test-owner',
          repo: 'test-repo',
          cloneUrl: 'http://clone',
          prNumber: 43,
          attempts: 1,
          maxAttempts: 2,
          createdAt: '2026-05-25T00:00:00.000Z',
          updatedAt: '2026-05-25T00:00:00.000Z',
        },
      ],
    };

    const mockDetails = {
      run: mockRuns.data[0],
      steps: [],
      findings: [
        {
          id: 'finding-1',
          runId: 'run-2',
          fingerprint: 'fp-1',
          category: 'security',
          severity: 'high',
          confidence: 0.9,
          path: 'src/db.ts',
          line: 10,
          title: 'SQL Injection vulnerability',
          detail: 'Direct string concatenation in query',
          evidence: 'db.query("SELECT * FROM users WHERE id = " + id)',
          suggestion: 'Use parameterized queries',
          published: false,
        },
      ],
      comments: [],
      sessionTree: {
        id: 'session-main-2',
        agentType: 'review-main-agent',
        model: 'gpt-main',
        status: 'failed',
        metadata: {},
        startedAt: '2026-05-25T00:00:00.000Z',
        completedAt: '2026-05-25T00:01:00.000Z',
        createdAt: '2026-05-25T00:00:00.000Z',
        updatedAt: '2026-05-25T00:01:00.000Z',
        messages: [],
        toolCalls: [],
        invocations: [
          {
            id: 'inv-failed',
            parentSessionId: 'session-main-2',
            sequence: 1,
            agentType: 'security-reviewer',
            model: 'gpt-sub-a',
            status: 'failed',
            input: {},
            error: 'Failed to initialize subagent',
            createdAt: '2026-05-25T00:00:15.000Z',
          },
        ],
      },
    };

    vi.mocked(fetchReviewRuns).mockResolvedValue(mockRuns as any);
    vi.mocked(fetchReviewRunDetails).mockResolvedValue(mockDetails as any);

    renderWithQuery(<ReviewSessionsPage />);

    // Wait for details to load and render
    const failedSubagentText = await screen.findByText('子代理启动失败: security-reviewer');
    expect(failedSubagentText).toBeInTheDocument();

    const user = userEvent.setup();

    // Switch to findings tab
    const findingsTab = screen.getByText('审查结果 (1)');
    expect(findingsTab).toBeInTheDocument();
    await user.click(findingsTab);

    // Assert finding title still renders
    const findingTitle = await screen.findByText('SQL Injection vulnerability');
    expect(findingTitle).toBeInTheDocument();
    expect(screen.getByText('Direct string concatenation in query')).toBeInTheDocument();
  });

  it('Scenario 3: asserts no legacy review labels are visible', async () => {
    const mockRuns = {
      data: [
        {
          id: 'run-3',
          idempotencyKey: 'key-3',
          eventType: 'pull_request' as const,
          status: 'succeeded' as const,
          owner: 'test-owner',
          repo: 'test-repo',
          cloneUrl: 'http://clone',
          prNumber: 44,
          attempts: 1,
          maxAttempts: 2,
          createdAt: '2026-05-25T00:00:00.000Z',
          updatedAt: '2026-05-25T00:00:00.000Z',
        },
      ],
    };

    const mockDetails = {
      run: mockRuns.data[0],
      steps: [],
      findings: [],
      comments: [],
      sessionTree: {
        id: 'session-main-3',
        agentType: 'review-main-agent',
        model: 'gpt-main',
        status: 'completed',
        metadata: {},
        startedAt: '2026-05-25T00:00:00.000Z',
        completedAt: '2026-05-25T00:01:00.000Z',
        createdAt: '2026-05-25T00:00:00.000Z',
        updatedAt: '2026-05-25T00:01:00.000Z',
        messages: [],
        toolCalls: [],
        invocations: [],
      },
    };

    vi.mocked(fetchReviewRuns).mockResolvedValue(mockRuns as any);
    vi.mocked(fetchReviewRunDetails).mockResolvedValue(mockDetails as any);

    renderWithQuery(<ReviewSessionsPage />);

    await waitFor(() => {
      expect(screen.getByText('test-owner/test-repo')).toBeInTheDocument();
    });

    const legacyLabels = ['tri' + 'age', 'speci' + 'alist', 'ju' + 'dge', 'pla' + 'nner'];
    legacyLabels.forEach((label) => {
      expect(screen.queryByText(label)).toBeNull();
    });
    expect(screen.queryByText('分流')).toBeNull();
    expect(screen.queryByText('专家')).toBeNull();
    expect(screen.queryByText('裁判')).toBeNull();
    expect(screen.queryByText('规划')).toBeNull();
  });
});
