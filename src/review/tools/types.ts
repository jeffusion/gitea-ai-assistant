import { z } from 'zod';

export type ToolExecutionSource = 'react' | 'planner' | 'kernel' | 'manual';
export type ToolPermissionScope =
  | 'read'
  | 'write'
  | 'command'
  | 'network'
  | 'git_write'
  | 'cross_session';
export type ToolPermissionBehavior = 'allow' | 'ask' | 'deny';

export interface Tool {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
  isConcurrencySafe?: boolean;
  timeoutMs?: number;
  permissionScope?: ToolPermissionScope;
  execute: (params: any, context: ToolExecutionContext) => Promise<any>;
}

export interface ToolExecutionContext {
  workspacePath: string;
  mirrorPath: string;
  runId: string;
  agentName?: string;
  agentId?: string;
  source?: ToolExecutionSource;
}

export interface ToolCall {
  id: string;
  toolName: string;
  parameters: any;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  result?: any;
  error?: string;
  durationMs?: number;
  isConcurrencySafe?: boolean;
  permissionBehavior?: ToolPermissionBehavior;
}

export interface ToolExecutionRecord {
  toolCallId: string;
  toolName: string;
  agentName?: string;
  agentId?: string;
  source?: ToolExecutionSource;
  success: boolean;
  durationMs: number;
  isConcurrencySafe: boolean;
  permissionBehavior?: ToolPermissionBehavior;
}
