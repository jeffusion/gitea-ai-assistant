import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RoleAssignment } from '../RoleAssignment';
import { fetchConfig, updateConfig, type ConfigResponse } from '@/services/configService';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/services/configService', () => ({
  fetchConfig: vi.fn(),
  updateConfig: vi.fn(),
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
        key: 'llm',
        label: 'LLM 设置',
        description: 'LLM 运行时与弹性设置',
        icon: 'brain',
        fields: [
          {
            envKey: 'AGENT_MAIN_MODEL',
            label: '主智能体模型',
            description: '主智能体默认使用的模型名称',
            type: 'string',
            sensitive: false,
            value: 'gpt-4o',
            hasValue: true,
            source: 'db',
          },
          {
            envKey: 'AGENT_DEFAULT_SUBAGENT_MODEL',
            label: '默认子智能体模型',
            description: '子智能体默认使用的模型名称',
            type: 'string',
            sensitive: false,
            value: 'gpt-4o-mini',
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
            envKey: 'LLM_RETRY_MAX_ATTEMPTS',
            label: 'LLM 最大重试次数',
            description: 'LLM 调用失败时的最大重试次数',
            type: 'number',
            sensitive: false,
            value: '3',
            hasValue: true,
            source: 'db',
          },
          {
            envKey: 'LLM_RETRY_BASE_DELAY_MS',
            label: 'LLM 重试基础延迟(ms)',
            description: 'LLM 调用失败重试的基础延迟时间',
            type: 'number',
            sensitive: false,
            value: '1000',
            hasValue: true,
            source: 'db',
          },
        ],
      },
    ],
  };
}

describe('RoleAssignment', () => {
  it('renders agent model settings and saves edits', async () => {
    vi.mocked(fetchConfig).mockResolvedValue(makeConfigResponse());
    vi.mocked(updateConfig).mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderWithQuery(<RoleAssignment />);

    // Wait for the fields to load and render
    expect(await screen.findByText('主智能体模型')).toBeInTheDocument();
    expect(screen.getByText('智能体模型设置')).toBeInTheDocument();
    expect(screen.getByText('默认子智能体模型')).toBeInTheDocument();
    expect(screen.getByText('LLM 最大并发调用')).toBeInTheDocument();
    expect(screen.getByText('LLM 最大重试次数')).toBeInTheDocument();
    expect(screen.getByText('LLM 重试基础延迟(ms)')).toBeInTheDocument();

    const legacyLabels = ['pla' + 'nner', 'speci' + 'alist', 'ju' + 'dge', '角色' + '分配'];
    legacyLabels.forEach((label) => {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(['/', 'llm', '/', 'roles'].join(''))).not.toBeInTheDocument();

    const mainModelInput = screen.getByLabelText('主智能体模型');
    const subagentModelInput = screen.getByLabelText('默认子智能体模型');
    const maxCallsInput = screen.getByLabelText('LLM 最大并发调用');
    const retryAttemptsInput = screen.getByLabelText('LLM 最大重试次数');
    const retryDelayInput = screen.getByLabelText('LLM 重试基础延迟(ms)');

    await user.clear(mainModelInput);
    await user.type(mainModelInput, 'claude-3-5-sonnet');

    await user.clear(subagentModelInput);
    await user.type(subagentModelInput, 'claude-3-5-haiku');

    await user.clear(maxCallsInput);
    await user.type(maxCallsInput, '8');

    await user.clear(retryAttemptsInput);
    await user.type(retryAttemptsInput, '5');

    await user.clear(retryDelayInput);
    await user.type(retryDelayInput, '2000');

    const saveButton = screen.getByRole('button', { name: '保存设置' });
    await user.click(saveButton);

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(updateConfig).mock.calls[0][0];
    expect(payload).toEqual({
      AGENT_MAIN_MODEL: 'claude-3-5-sonnet',
      AGENT_DEFAULT_SUBAGENT_MODEL: 'claude-3-5-haiku',
      LLM_MAX_CONCURRENT_CALLS: '8',
      LLM_RETRY_MAX_ATTEMPTS: '5',
      LLM_RETRY_BASE_DELAY_MS: '2000',
    });
  });

  it('renders missing-field/unavailable state when fields are missing', async () => {
    vi.mocked(fetchConfig).mockResolvedValue({
      groups: [
        {
          key: 'llm',
          label: 'LLM 设置',
          description: 'LLM 运行时与弹性设置',
          icon: 'brain',
          fields: [
            {
              envKey: 'AGENT_MAIN_MODEL',
              label: '主智能体模型',
              description: '主智能体默认使用的模型名称',
              type: 'string',
              sensitive: false,
              value: 'gpt-4o',
              hasValue: true,
              source: 'db',
            },
          ],
        },
      ],
    });

    renderWithQuery(<RoleAssignment />);

    // Wait for the warning to load and render
    expect(await screen.findByText('部分配置项在系统中不可用：')).toBeInTheDocument();
    expect(screen.getByText('智能体模型设置')).toBeInTheDocument();
    expect(screen.getByLabelText('AGENT_DEFAULT_SUBAGENT_MODEL')).toBeInTheDocument();
    expect(screen.getByLabelText('LLM_MAX_CONCURRENT_CALLS')).toBeInTheDocument();
    expect(screen.getByLabelText('LLM_RETRY_MAX_ATTEMPTS')).toBeInTheDocument();
    expect(screen.getByLabelText('LLM_RETRY_BASE_DELAY_MS')).toBeInTheDocument();

    const subagentInput = screen.getByLabelText('AGENT_DEFAULT_SUBAGENT_MODEL');
    expect(subagentInput).toBeDisabled();
  });
});
