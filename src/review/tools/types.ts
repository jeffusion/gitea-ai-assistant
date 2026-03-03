import { z } from 'zod';

export interface Tool {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  execute: (params: any, context: ToolExecutionContext) => Promise<any>;
}

export interface ToolExecutionContext {
  workspacePath: string;
  mirrorPath: string;
  runId: string;
}

export interface ToolCall {
  id: string;
  toolName: string;
  parameters: any;
}

export interface ToolResult {
  toolCallId: string;
  success: boolean;
  result?: any;
  error?: string;
}
