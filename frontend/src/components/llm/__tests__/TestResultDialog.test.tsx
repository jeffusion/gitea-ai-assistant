import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TestResultDialog } from '../TestResultDialog';

describe('TestResultDialog', () => {
  it('renders success state with latency, model and message', () => {
    render(
      <TestResultDialog
        open
        onOpenChange={vi.fn()}
        providerName="DeepSeek"
        result={{
          success: true,
          latencyMs: 123,
          model: 'deepseek-chat',
          message: '连接已建立',
        }}
      />,
    );

    expect(screen.getByText('测试结果 - DeepSeek')).toBeInTheDocument();
    expect(screen.getByText('连接成功')).toBeInTheDocument();
    expect(screen.getByText('延迟:')).toBeInTheDocument();
    expect(screen.getByText('123 ms')).toBeInTheDocument();
    expect(screen.getByText('模型:')).toBeInTheDocument();
    expect(screen.getByText('deepseek-chat')).toBeInTheDocument();
    expect(screen.getByText('AI 响应:')).toBeInTheDocument();
    expect(screen.getByText('连接已建立')).toBeInTheDocument();
  });

  it('renders error state and closes via button', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();

    render(
      <TestResultDialog
        open
        onOpenChange={onOpenChange}
        providerName="OpenAI"
        result={{
          success: false,
          latencyMs: 789,
          error: '认证失败',
        }}
      />,
    );

    expect(screen.getByText('测试失败')).toBeInTheDocument();
    expect(screen.getByText('延迟:')).toBeInTheDocument();
    expect(screen.getByText('789 ms')).toBeInTheDocument();
    expect(screen.getByText('错误:')).toBeInTheDocument();
    expect(screen.getByText('认证失败')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
