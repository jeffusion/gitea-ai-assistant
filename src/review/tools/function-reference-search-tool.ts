import { z } from 'zod';
import { SandboxExec } from '../context/sandbox-exec';
import { Tool } from './types';

// 转义正则元字符，将identifier中的特殊字符转义为字面量
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createFunctionReferenceSearchTool(sandbox: SandboxExec): Tool {
  return {
    name: 'search_function_references',
    description:
      '搜索指定函数、方法或类的所有引用和定义（支持所有编程语言）。用于理解代码影响范围和调用关系。',
    parameters: z.object({
      identifier: z.string().describe('要搜索的标识符（函数名、类名、方法名等）'),
      file_types: z
        .array(z.string())
        .optional()
        .describe('限制搜索的文件类型，如["ts", "go", "py", "java"]'),
      search_type: z
        .enum(['calls', 'definitions', 'all'])
        .default('all')
        .describe('搜索类型：calls=仅调用，definitions=仅定义，all=全部'),
      max_results: z.number().default(30).describe('最大返回结果数'),
    }),
    execute: async (params, context) => {
      const { identifier, file_types, search_type, max_results } = params;

      // 转义identifier中的正则元字符，避免被解释为正则语法
      const escapedId = escapeRegex(identifier);

      // 定义调用模式（适配多种语言）
      const callPatterns: string[] = [
        `${escapedId}\\s*\\(`, // 直接调用: functionName(
        `\\.${escapedId}\\s*\\(`, // 方法调用: obj.methodName(
        `::${escapedId}\\s*\\(`, // C++/Rust静态调用: Class::method(
        `${escapedId}\\s*<[^>]+>\\s*\\(`, // 泛型调用: functionName<T>( (修复：限制<>内容)
      ];

      // 定义声明模式（多语言）
      const definitionPatterns: string[] = [
        `func\\s+${escapedId}\\s*\\(`, // Go: func functionName(
        `fn\\s+${escapedId}\\s*\\(`, // Rust: fn functionName(
        `def\\s+${escapedId}\\s*\\(`, // Python: def functionName(
        `function\\s+${escapedId}\\s*\\(`, // JavaScript: function functionName(
        `${escapedId}\\s*:\\s*function`, // JS对象方法: methodName: function
        `${escapedId}\\s*=\\s*\\([^)]*\\)\\s*=>`, // Arrow function: const fn = () => (修复：限制参数)
        `class\\s+${escapedId}\\s*[{<]`, // 类定义: class ClassName {
        `interface\\s+${escapedId}\\s*[{<]`, // 接口: interface InterfaceName {
        `type\\s+${escapedId}\\s*=`, // 类型别名: type TypeName =
        `struct\\s+${escapedId}\\s*[{]`, // Go/Rust struct: struct StructName {
        `public\\s+[^(]*\\s+${escapedId}\\s*\\(`, // Java方法: public void methodName(
        `private\\s+[^(]*\\s+${escapedId}\\s*\\(`, // Java私有方法
      ];

      // 根据search_type选择模式
      interface SearchTask {
        patterns: string[];
        type: 'call' | 'definition';
      }

      const tasks: SearchTask[] = [];
      if (search_type === 'calls' || search_type === 'all') {
        tasks.push({ patterns: callPatterns, type: 'call' });
      }
      if (search_type === 'definitions' || search_type === 'all') {
        tasks.push({ patterns: definitionPatterns, type: 'definition' });
      }

      // 分别执行搜索任务
      const allReferences: Array<{
        path: string;
        line: number;
        content: string;
        type: 'call' | 'definition';
      }> = [];

      for (const task of tasks) {
        const pattern = task.patterns.join('|');
        const args = [
          '--json',
          '--max-count',
          String(max_results || 30),
        ];

        if (file_types && file_types.length > 0) {
          args.push('--type-add', `custom:*.{${file_types.join(',')}}`);
          args.push('--type', 'custom');
        }

        // -e pattern 和路径必须在所有选项之后
        args.push('-e', pattern, context.workspacePath);

        try {
          const result = await sandbox.run('rg', args, {
            cwd: context.workspacePath,
            timeoutMs: 15000,
          });

          if (result.stdout.trim()) {
            // 解析ripgrep JSON输出
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
              .filter((event) => event && event.type === 'match');

            // 转换为统一格式，使用task.type作为分类
            for (const m of matches) {
              allReferences.push({
                path: m.data?.path?.text || '',
                line: m.data?.line_number || 0,
                content: (m.data?.lines?.text || '').trim(),
                type: task.type,
              });
            }
          }
        } catch (error) {
          // ripgrep返回exit code 1表示无匹配，这是正常的，继续处理
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (!errorMessage.includes('code=1')) {
            // 非"无匹配"的错误才需要记录
            console.warn(`Search ${task.type} failed:`, errorMessage);
          }
        }
      }

      // 去重（同一位置可能同时匹配调用和定义模式）
      const uniqueRefs = new Map<string, (typeof allReferences)[0]>();
      for (const ref of allReferences) {
        const key = `${ref.path}:${ref.line}`;
        if (!uniqueRefs.has(key)) {
          uniqueRefs.set(key, ref);
        } else {
          // 如果重复，优先保留definition类型
          const existing = uniqueRefs.get(key)!;
          if (ref.type === 'definition' && existing.type === 'call') {
            uniqueRefs.set(key, ref);
          }
        }
      }

      const references = Array.from(uniqueRefs.values()).slice(0, max_results || 30);

      if (references.length === 0) {
        return {
          identifier,
          references: [],
          total: 0,
          message: `未找到 ${identifier} 的引用`,
          note: '这是基于正则模式的近似搜索，可能遗漏动态调用或同名符号',
        };
      }

      // 统计
      const callCount = references.filter((r) => r.type === 'call').length;
      const defCount = references.filter((r) => r.type === 'definition').length;

      return {
        identifier,
        references,
        total: references.length,
        statistics: {
          calls: callCount,
          definitions: defCount,
        },
        summary: `找到 ${defCount} 个定义，${callCount} 个调用`,
        note: '⚠️ 基于正则的近似搜索，可能包含字符串/注释中的匹配。建议查看实际代码确认。',
      };
    },
  };
}
