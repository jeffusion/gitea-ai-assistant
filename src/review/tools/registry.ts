import zodToJsonSchema from 'zod-to-json-schema';
import type { JsonSchema7Type } from 'zod-to-json-schema';
import { z } from 'zod';
import { Tool } from './types';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  // 转换为OpenAI Function定义
  toOpenAIFunctions() {
    return this.getAll().map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.zodToJsonSchema(tool.parameters),
      },
    }));
  }

  private zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema7Type {
    /**
     * 使用zod-to-json-schema库转换Zod schema为JSON Schema。
     *
     * 注意：该库v3.25.1使用了复杂的条件类型推断，会导致 TS2589
     * "Type instantiation is excessively deep" 错误。这是库的已知限制，
     * 见 https://github.com/StefanTerdell/zod-to-json-schema/issues
     *
     * 类型安全保证：
     * - 输入：z.ZodTypeAny 确保只接受Zod schema
     * - 输出：JsonSchema7Type 明确返回类型
     * - 运行时行为：库本身经过充分测试，转换逻辑正确
     */
    // @ts-expect-error TS2589: zod-to-json-schema v3.25.1 的条件类型过于复杂
    return zodToJsonSchema(schema, {
      target: 'openApi3',
      $refStrategy: 'none',
    });
  }
}
