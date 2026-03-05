import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ModelCombobox } from '../ModelCombobox';

vi.mock('@/services/llmProviderService', async () => {
  const actual = await vi.importActual<typeof import('@/services/llmProviderService')>('@/services/llmProviderService');
  return {
    ...actual,
    fetchModelSuggestions: vi.fn().mockResolvedValue({
      openai_compatible: ['gpt-4o', 'gpt-4o-mini', 'deepseek-chat'],
      openai_responses: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
      anthropic: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
      gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    }),
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
  it('shows 推荐 models matching providerType and supports custom input', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithQuery(
      <ModelCombobox providerType="openai_compatible" value="" onChange={onChange} />,
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

  it('shows different models when providerType changes', async () => {
    const onChange = vi.fn();

    renderWithQuery(
      <ModelCombobox providerType="anthropic" value="" onChange={onChange} />,
    );

    const input = screen.getByPlaceholderText('选择或输入模型...');
    await userEvent.click(input);

    expect(await screen.findByText('claude-sonnet-4-20250514')).toBeInTheDocument();
    expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
  });
});
