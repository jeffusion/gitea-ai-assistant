import type { ToolExecutionContext } from '../../review/tools/types';
import type { KernelDelegationPacket, KernelSubagentInvocationResult } from '../types';

export type KernelHookEventName =
  | 'SessionStart'
  | 'SubagentStart'
  | 'PermissionRequest'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure';

export interface SessionStartHookInput {
  event: 'SessionStart';
  sessionId: string;
  runId: string;
  scopeKey: string;
}

export interface SubagentStartHookInput {
  event: 'SubagentStart';
  sessionId: string;
  runId: string;
  subagentName: string;
  agentId: string;
  packet: KernelDelegationPacket;
}

export interface PreToolUseHookInput {
  event: 'PreToolUse';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  context: ToolExecutionContext;
}

export interface PermissionRequestHookInput {
  event: 'PermissionRequest';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  context: ToolExecutionContext;
  suggestedBehavior: 'ask' | 'deny';
  reason: string;
}

export interface PostToolUseHookInput {
  event: 'PostToolUse';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  output: unknown;
  context: ToolExecutionContext;
}

export interface PostToolUseFailureHookInput {
  event: 'PostToolUseFailure';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  error: string;
  context: ToolExecutionContext;
}

export type KernelHookInput =
  | SessionStartHookInput
  | SubagentStartHookInput
  | PermissionRequestHookInput
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput;

export interface KernelHookResult {
  continue?: boolean;
  additionalContext?: string;
  updatedInput?: Record<string, unknown>;
  decision?: 'approve' | 'block';
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface KernelHookDefinition {
  name: string;
  event: KernelHookEventName;
  description: string;
  execute(input: KernelHookInput): Promise<KernelHookResult | undefined>;
}

export interface KernelLifecycleResult {
  results: KernelHookResult[];
  additionalContexts: string[];
  updatedInput?: Record<string, unknown>;
  blockingReason?: string;
}

export interface KernelSubagentCompletionEnvelope {
  invocationId: string;
  subagentName: string;
  result: KernelSubagentInvocationResult;
}
