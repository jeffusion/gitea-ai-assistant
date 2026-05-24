import type { Tool, ToolExecutionContext, ToolPermissionBehavior } from './types';

export interface ToolPermissionDecision {
  behavior: ToolPermissionBehavior;
  reason: string;
}

const DEFAULT_POLICY: Record<NonNullable<Tool['permissionScope']>, ToolPermissionBehavior> = {
  read: 'allow',
  write: 'ask',
  command: 'ask',
  network: 'deny',
  git_write: 'ask',
  cross_session: 'deny',
};

export function evaluateToolPermission(
  tool: Tool,
  _context: ToolExecutionContext
): ToolPermissionDecision {
  const scope = tool.permissionScope ?? 'read';
  const behavior = DEFAULT_POLICY[scope];

  if (behavior === 'allow') {
    return {
      behavior,
      reason: `Tool '${tool.name}' is allowed for scope '${scope}'`,
    };
  }

  if (behavior === 'ask') {
    return {
      behavior,
      reason: `Tool '${tool.name}' requires approval for scope '${scope}'`,
    };
  }

  return {
    behavior,
    reason: `Tool '${tool.name}' is denied for scope '${scope}'`,
  };
}
