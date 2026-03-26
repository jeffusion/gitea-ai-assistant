import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RepositoryConfigCell } from '../RepositoryConfigCell';
import type { Repository } from '@/services/repositoryService';

const apiMocks = vi.hoisted(() => ({
  put: vi.fn(),
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

describe('RepositoryConfigCell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens prompt dialog and saves project prompt', async () => {
    apiMocks.put.mockResolvedValueOnce({
      data: {
        success: true,
        project_review_prompt: 'focus null safety',
      },
    });

    const user = userEvent.setup();
    renderWithQuery(<RepositoryConfigCell repo={makeRepo()} />);

    await user.click(screen.getByRole('button', { name: /配置/i }));
    
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('配置项目级提示词')).toBeInTheDocument();

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, '  focus null safety  ');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(apiMocks.put).toHaveBeenCalledWith(
        '/repositories/demo-owner/demo-repo/project-prompt',
        { project_review_prompt: 'focus null safety' }
      );
    });
  });
});
