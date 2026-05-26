import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ReviewConfigPage } from '../ReviewConfigPage';
import { fetchConfig, updateConfig, resetConfig, type ConfigResponse } from '@/services/configService';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/services/configService', () => ({
  fetchConfig: vi.fn(),
  updateConfig: vi.fn(),
  resetConfig: vi.fn(),
}));

vi.mock('../llm/ProviderList', () => ({
  ProviderList: () => <div>ProviderListMock</div>,
}));

vi.mock('../llm/RoleAssignment', () => ({
  RoleAssignment: () => <div>RoleAssignmentMock</div>,
}));

vi.mock('../llm/ModelCombobox', () => ({
  ModelCombobox: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <input aria-label="Codex model" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
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

function makeConfigResponse(): ConfigResponse {
  return {
    groups: [
      {
        key: 'review',
        label: '审查引擎',
        description: 'Agent 审查模式、并发与沙箱设置',
        icon: 'file-check',
        fields: [
          {
            envKey: 'REVIEW_ENGINE',
            label: '审查引擎',
            description: '代码审查模式',
            type: 'enum',
            sensitive: false,
            enumValues: ['agent', 'codex'],
            value: 'agent',
            hasValue: true,
            source: 'db',
          },
          {
            envKey: 'GLOBAL_PROMPT',
            label: '全局提示词',
            description: '附加到所有 LLM 调用',
            type: 'text',
            sensitive: false,
            value: '',
            hasValue: false,
            source: 'default',
          },
          {
            envKey: 'REVIEW_WORKDIR',
            label: '工作目录',
            description: 'Agent 模式下本地仓库目录',
            type: 'string',
            sensitive: false,
            value: '/tmp/gitea-assistant',
            hasValue: true,
            source: 'db',
          },
          {
            envKey: 'REVIEW_MAX_PARALLEL_RUNS',
            label: '最大并发数',
            description: '单机同时执行的审查任务上限',
            type: 'number',
            sensitive: false,
            value: '2',
            hasValue: true,
            source: 'db',
          },
          {
            envKey: 'REVIEW_ALLOWED_COMMANDS',
            label: '允许命令',
            description: '本地审查沙箱命令白名单',
            type: 'string',
            sensitive: false,
            value: 'git,rg,cat,sed,wc',
            hasValue: true,
            source: 'db',
          },
          {
            envKey: 'REVIEW_COMMAND_TIMEOUT_MS',
            label: '命令超时(ms)',
            description: '单条本地命令的执行超时时间',
            type: 'number',
            sensitive: false,
            min: 120000,
            max: 300000,
            value: '120000',
            hasValue: true,
            source: 'db',
          },
          {
            envKey: 'LLM_MAX_CONCURRENT_CALLS',
            label: 'LLM 最大并发调用',
            description: '同时在飞的 LLM API 调用上限',
            type: 'number',
            sensitive: false,
            value: '4',
            hasValue: true,
            source: 'db',
          },
          {
            envKey: 'REVIEW_TOKEN_BUDGET_LARGE',
            label: 'Large 令牌预算',
            description: 'large 规模审查任务的 token 预算上限',
            type: 'number',
            sensitive: false,
            value: '120000',
            hasValue: true,
            source: 'db',
          },
          {
            envKey: 'CODEX_MODEL',
            label: 'Codex 模型',
            description: 'Codex CLI 使用的模型名称',
            type: 'string',
            sensitive: false,
            value: 'o3',
            hasValue: true,
            source: 'db',
          },
        ],
      },
    ],
  };
}

describe('ReviewConfigPage', () => {
  it('shows only current Agent config surface and saves only visible fields', async () => {
    vi.mocked(fetchConfig).mockResolvedValue(makeConfigResponse());
    vi.mocked(updateConfig).mockResolvedValue(undefined);
    vi.mocked(resetConfig).mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderWithQuery(<ReviewConfigPage />);

    expect(await screen.findByText('Agent 审查设置')).toBeInTheDocument();
    expect(screen.getByText('REVIEW_COMMAND_TIMEOUT_MS')).toBeInTheDocument();
    expect(screen.queryByText('REVIEW_TOKEN_BUDGET_LARGE')).not.toBeInTheDocument();
    expect(screen.queryByText('REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE')).not.toBeInTheDocument();
    expect(screen.queryByText('REVIEW_ENABLE_HUMAN_GATE')).not.toBeInTheDocument();
    expect(screen.queryByText('ENABLE_TRIAGE')).not.toBeInTheDocument();

    const workdirInput = screen.getByDisplayValue('/tmp/gitea-assistant');
    await user.clear(workdirInput);
    await user.type(workdirInput, '/tmp/new-review-workdir');
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(updateConfig).mock.calls[0][0];
    expect(payload.REVIEW_WORKDIR).toBe('/tmp/new-review-workdir');
    expect(payload.REVIEW_ENGINE).toBe('agent');
    expect(payload.REVIEW_COMMAND_TIMEOUT_MS).toBe('120000');
    expect(payload).not.toHaveProperty('REVIEW_TOKEN_BUDGET_LARGE');
    expect(payload).not.toHaveProperty('REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE');
    expect(payload).not.toHaveProperty('REVIEW_ENABLE_HUMAN_GATE');
    expect(payload).not.toHaveProperty('ENABLE_TRIAGE');
  });
});
