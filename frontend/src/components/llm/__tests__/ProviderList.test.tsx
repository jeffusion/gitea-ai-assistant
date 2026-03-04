import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderList } from '../ProviderList';
import {
  fetchProviders,
  fetchRoles,
  updateProvider,
  deleteProvider,
  testProvider,
} from '@/services/llmProviderService';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/services/llmProviderService', () => ({
  fetchProviders: vi.fn(),
  fetchRoles: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  testProvider: vi.fn(),
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

describe('ProviderList', () => {
  it('renders providers, enable states and hasKey indicators', async () => {
    vi.mocked(fetchProviders).mockResolvedValueOnce([
      {
        id: 'p1',
        name: 'OpenAI 官方',
        type: 'openai_responses',
        baseUrl: null,
        defaultModel: 'gpt-4o',
        isEnabled: true,
        hasKey: true,
        extraConfig: {},
        createdAt: '2026-01-01',
      },
      {
        id: 'p2',
        name: '本地兼容服务',
        type: 'openai_compatible',
        baseUrl: 'https://example.com/v1',
        defaultModel: 'qwen-plus',
        isEnabled: false,
        hasKey: false,
        extraConfig: {},
        createdAt: '2026-01-01',
      },
    ]);
    vi.mocked(fetchRoles).mockResolvedValueOnce([]);
    vi.mocked(updateProvider).mockResolvedValue({} as never);
    vi.mocked(deleteProvider).mockResolvedValue(undefined);
    vi.mocked(testProvider).mockResolvedValue({ success: true });

    renderWithQuery(<ProviderList />);

    expect(await screen.findByText('模型提供商')).toBeInTheDocument();
    expect(await screen.findByText('OpenAI 官方')).toBeInTheDocument();
    expect(await screen.findByText('本地兼容服务')).toBeInTheDocument();
    expect(screen.getByText('OpenAI Responses')).toBeInTheDocument();
    expect(screen.getByText('OpenAI 兼容')).toBeInTheDocument();
    expect(screen.getByText('就绪')).toBeInTheDocument();
    expect(screen.getByText('无 Key')).toBeInTheDocument();

    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    expect(switches[0]).toHaveAttribute('data-state', 'checked');
    expect(switches[1]).toHaveAttribute('data-state', 'unchecked');

    const testButtons = screen.getAllByTitle('测试连接');
    expect(testButtons).toHaveLength(2);
    expect(testButtons[0]).toBeEnabled();
    expect(testButtons[1]).toBeDisabled();
  });
});
