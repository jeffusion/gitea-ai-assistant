import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Tool } from './types';

export function createFileReadTool(): Tool {
  return {
    name: 'read_file',
    description: '读取指定文件的完整内容，用于深入分析代码逻辑。',
    isConcurrencySafe: true,
    permissionScope: 'read',
    parameters: z.object({
      file_path: z.string().describe('相对文件路径'),
      start_line: z.number().optional().describe('起始行号（可选）'),
      end_line: z.number().optional().describe('结束行号（可选）'),
    }),
    execute: async (params, context) => {
      const { file_path, start_line, end_line } = params;

      // 安全性：规范化路径并验证是否在workspace内
      const normalizedPath = path.normalize(file_path).replace(/^(\.\.[\/\\])+/, '');
      const fullPath = path.resolve(context.workspacePath, normalizedPath);

      try {
        // 使用realpath解析完整路径（跟随所有符号链接）
        const realPath = await realpath(fullPath);
        const workspaceRealPath = await realpath(context.workspacePath);

        // 验证解析后的真实路径必须在workspace目录下
        if (!realPath.startsWith(workspaceRealPath + path.sep) && realPath !== workspaceRealPath) {
          return {
            error: `安全错误：路径 "${file_path}" 解析到workspace外部 (${realPath})`,
            path: file_path,
          };
        }

        const content = await readFile(realPath, 'utf-8');

        if (start_line !== undefined && end_line !== undefined) {
          const lines = content.split('\n');
          return {
            path: file_path,
            content: lines.slice(start_line - 1, end_line).join('\n'),
            lines: `${start_line}-${end_line}`,
          };
        }

        return {
          path: file_path,
          content,
          totalLines: content.split('\n').length,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          path: file_path,
        };
      }
    },
  };
}
