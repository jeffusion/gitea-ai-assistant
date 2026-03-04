import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ModelCombobox } from '../ModelCombobox';
import { fetchModels } from '@/services/llmProviderService';

vi.mock('@/services/llmProviderService', async () => {
  const actual = await vi.importActual<typeof import('@/services/llmProviderService')>('@/services/llmProviderService');
  return {
    ...actual,
    fetchModels: vi.fn(),
  };
});

function renderWithQuery(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('ModelCombobox', () => {
  it('shows API tag and selects API model', async () => {
    vi.mocked(fetchModels).mockResolvedValueOnce(['api-model-1']);
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithQuery(
      <ModelCombobox providerId="p1" providerType="openai_compatible" value="" onChange={onChange} />,
    );

    const input = screen.getByPlaceholderText('选择或输入模型...');
    await user.click(input);

    expect(await screen.findByText('api-model-1')).toBeInTheDocument();
    expect(screen.getByText('API')).toBeInTheDocument();

    await user.click(screen.getByText('api-model-1'));
    expect(onChange).toHaveBeenCalledWith('api-model-1');
  });

  it('shows 推荐 and 自定义 tags and supports custom input', async () => {
    vi.mocked(fetchModels).mockResolvedValueOnce([]);
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithQuery(
      <ModelCombobox providerId="p2" providerType="openai_compatible" value="" onChange={onChange} />,
    );

    const input = screen.getByPlaceholderText('选择或输入模型...');
    await user.click(input);

    expect((await screen.findAllByText('推荐')).length).toBeGreaterThan(0);
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'my-custom-model');

    expect(await screen.findByText('自定义')).toBeInTheDocument();
    await user.click(screen.getByText('my-custom-model'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('my-custom-model');
    });
  });
});
