import { z } from 'zod';
import { SandboxExec } from '../context/sandbox-exec';
import { Tool } from './types';

export function createCodeSearchTool(sandbox: SandboxExec): Tool {
  return {
    name: 'search_code',
    description: '在代码库中搜索匹配给定模式的代码，支持正则表达式。用于发现相似问题或影响范围。',
    isConcurrencySafe: true,
    timeoutMs: 10000,
    permissionScope: 'read',
    parameters: z.object({
      pattern: z.string().describe('要搜索的正则表达式模式'),
      file_types: z.array(z.string()).optional().describe('限制搜索的文件类型，如["ts", "js"]'),
      max_results: z.number().default(20).describe('最大返回结果数'),
    }),
    execute: async (params, context) => {
      const { pattern, file_types, max_results } = params;

      // 构建ripgrep参数：选项必须在--之前，--之后只能是pattern和路径等位置参数
      const args = ['--json', '--max-count', String(max_results || 20)];

      if (file_types && file_types.length > 0) {
        args.push('--type-add', `custom:*.{${file_types.join(',')}}`);
        args.push('--type', 'custom');
      }

      // 使用--分隔选项和pattern，防止pattern以-开头时被误解析为ripgrep选项
      args.push('--', pattern, context.workspacePath);

      try {
        const result = await sandbox.run('rg', args, {
          cwd: context.workspacePath,
          timeoutMs: 10000,
        });

        if (!result.stdout.trim()) {
          return { matches: [], message: '未找到匹配结果' };
        }

        // 解析ripgrep JSON输出并过滤只保留match事件（排除begin/end/summary）
        const matches = result.stdout
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter((event) => event && event.type === 'match')
          .slice(0, max_results || 20);

        return {
          matches: matches.map((m: any) => ({
            path: m.data?.path?.text || '',
            line: m.data?.line_number || 0,
            content: m.data?.lines?.text || '',
          })),
          total: matches.length,
        };
      } catch (error) {
        // ripgrep返回exit code 1表示无匹配（正常情况），不应视为错误
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('code=1')) {
          return { matches: [], message: '未找到匹配结果' };
        }

        // 其他错误（超时、权限等）才是真正的失败
        return {
          error: errorMessage,
          matches: [],
        };
      }
    },
  };
}
