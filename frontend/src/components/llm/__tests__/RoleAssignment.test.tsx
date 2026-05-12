import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RoleAssignment } from '../RoleAssignment';
import {
  fetchKernelSubagents,
  fetchProviders,
  fetchRoles,
  setRole,
} from '@/services/llmProviderService';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/services/llmProviderService', async () => {
  const actual = await vi.importActual<typeof import('@/services/llmProviderService')>('@/services/llmProviderService');
  return {
    ...actual,
    fetchProviders: vi.fn(),
    fetchKernelSubagents: vi.fn(),
    fetchRoles: vi.fn(),
    setRole: vi.fn(),
    fetchModelSuggestions: vi.fn().mockResolvedValue({
      openai_compatible: ['gpt-4o', 'gpt-4o-mini'],
      openai_responses: ['gpt-4o', 'gpt-4o-mini'],
      anthropic: ['claude-sonnet-4-20250514'],
      gemini: ['gemini-2.5-pro'],
    }),
  };
});

function renderWithQuery(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('RoleAssignment', () => {
  it('renders subagent directory and model role routing', async () => {
    vi.mocked(fetchProviders).mockResolvedValueOnce([
      {
        id: 'p1',
        name: 'OpenAI',
        type: 'openai_responses',
        baseUrl: null,
        defaultModel: 'gpt-4o-mini',
        isEnabled: true,
        hasKey: true,
        extraConfig: {},
        createdAt: '2026-01-01',
      },
    ]);

    vi.mocked(fetchRoles).mockResolvedValueOnce([
      {
        role: 'planner',
        providerId: 'p1',
        providerName: 'OpenAI',
        providerType: 'openai_responses',
        model: 'gpt-4o',
      },
    ]);

    vi.mocked(fetchKernelSubagents).mockResolvedValueOnce([
      {
        kind: 'subagent',
        name: 'review:triage',
        source: 'built-in',
        description: '根据变更范围决定 review 域与审查模式',
        whenToUse: '当需要规划任务时',
        modelRole: 'planner',
        tags: ['review', 'planner', 'triage'],
        resumable: true,
      },
      {
        kind: 'subagent',
        name: 'review:specialist:security',
        source: 'built-in',
        description: '专项审查 security 域变更',
        whenToUse: '当 security 风险域被命中时',
        modelRole: 'specialist',
        tags: ['review', 'specialist', 'domain-review', 'domain:security'],
        resumable: true,
      },
    ]);

    vi.mocked(setRole).mockResolvedValue({
      role: 'planner',
      providerId: 'p1',
      providerName: 'OpenAI',
      providerType: 'openai_responses',
      model: 'custom-planner-model',
    });

    const user = userEvent.setup();
    renderWithQuery(<RoleAssignment />);

    expect(await screen.findByText('Subagents 与模型路由')).toBeInTheDocument();
    expect((await screen.findAllByText('review:triage')).length).toBeGreaterThan(0);
    expect(screen.getByText('模型角色路由')).toBeInTheDocument();
    expect(screen.getByText('Planner')).toBeInTheDocument();
    expect(screen.getByText('Specialist')).toBeInTheDocument();

    const providerPlaceholders = screen.getAllByText('选择提供商');
    const triggerButton = providerPlaceholders[0].closest('button')!;
    await user.click(triggerButton);
    await user.click(await screen.findByRole('option', { name: /OpenAI/ }));

    const modelInputs = screen.getAllByPlaceholderText('选择或输入模型...') as HTMLInputElement[];
    await waitFor(() => {
      expect(modelInputs[0].value).toBe('gpt-4o');
    });

    await user.clear(modelInputs[0]);
    await user.type(modelInputs[0], 'custom-planner-model');
    expect(modelInputs[0].value).toBe('custom-planner-model');
  });
});
