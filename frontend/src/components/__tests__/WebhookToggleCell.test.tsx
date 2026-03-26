import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookToggleCell } from '../WebhookToggleCell';
import type { Repository } from '@/services/repositoryService';

const apiMocks = vi.hoisted(() => ({
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  default: apiMocks,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
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

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    name: 'demo-owner/demo-repo',
    webhook_status: 'inactive',
    hook_id: null,
    project_review_prompt: null,
    ...overrides,
  };
}

describe('WebhookToggleCell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toggles webhook via switch to enable', async () => {
    apiMocks.post.mockResolvedValueOnce({ data: { success: true } });

    const user = userEvent.setup();
    renderWithQuery(<WebhookToggleCell repo={makeRepo()} />);

    const switchEl = screen.getByRole('switch');
    expect(switchEl).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('未启用')).toBeInTheDocument();
    
    await user.click(switchEl);

    await waitFor(() => {
      expect(apiMocks.post).toHaveBeenCalledWith('/repositories/demo-owner/demo-repo/webhook');
    });
  });

  it('toggles webhook via switch to disable', async () => {
    apiMocks.delete.mockResolvedValueOnce({ data: { success: true } });

    const user = userEvent.setup();
    renderWithQuery(<WebhookToggleCell repo={makeRepo({ webhook_status: 'active', hook_id: 123 })} />);

    const switchEl = screen.getByRole('switch');
    expect(switchEl).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('已启用')).toBeInTheDocument();
    
    await user.click(switchEl);

    await waitFor(() => {
      expect(apiMocks.delete).toHaveBeenCalledWith('/repositories/demo-owner/demo-repo/webhook/123');
    });
  });
});
