import type { MainAgentTool } from '../loop';
import type { ToolPermissionBehavior, ToolPermissionScope } from '../loop/types';

export interface ResolveAgentToolsInput {
  availableTools: MainAgentTool[];
  allowedToolNames: string[];
  disallowedToolNames: string[];
  allowListSpecified?: boolean;
}

export interface ResolvedAgentTools {
  tools: MainAgentTool[];
  allowedToolNames: string[];
  disallowedToolNames: string[];
  deniedToolNames: string[];
  unknownAllowedToolNames: string[];
  unknownDisallowedToolNames: string[];
}

export interface ToolPermissionDecision {
  behavior: ToolPermissionBehavior;
  reason: string;
}

const DEFAULT_SCOPE_POLICY: Record<ToolPermissionScope, ToolPermissionBehavior> = {
  read: 'allow',
  write: 'deny',
  command: 'deny',
  network: 'deny',
  git_write: 'deny',
  cross_session: 'deny',
};

function uniqueNames(names: string[]): string[] {
  return [...new Set(names)];
}

export function evaluateToolPermission(tool: MainAgentTool): ToolPermissionDecision {
  const scope = tool.permissionScope ?? 'read';
  const behavior = DEFAULT_SCOPE_POLICY[scope];
  return {
    behavior,
    reason: `Tool '${tool.definition.name}' ${behavior === 'allow' ? 'allowed' : 'denied'} for scope '${scope}'`,
  };
}

export function resolveAgentTools(input: ResolveAgentToolsInput): ResolvedAgentTools {
  const availableToolNames = uniqueNames(input.availableTools.map((tool) => tool.definition.name));
  const availableToolNamesSet = new Set(availableToolNames);
  const allowedToolNames = uniqueNames(input.allowedToolNames);
  const disallowedToolNames = uniqueNames(input.disallowedToolNames);
  const allowedToolNamesSet = new Set(allowedToolNames);
  const disallowedToolNamesSet = new Set(disallowedToolNames);

  const tools = input.availableTools.filter((tool) => {
    const toolName = tool.definition.name;
    if (disallowedToolNamesSet.has(toolName)) return false;
    if (allowedToolNamesSet.size > 0) return allowedToolNamesSet.has(toolName);
    if (input.allowListSpecified) return false;
    return evaluateToolPermission(tool).behavior === 'allow';
  });
  const permittedToolNamesSet = new Set(tools.map((tool) => tool.definition.name));

  return {
    tools,
    allowedToolNames,
    disallowedToolNames,
    deniedToolNames: availableToolNames.filter((toolName) => !permittedToolNamesSet.has(toolName)),
    unknownAllowedToolNames: allowedToolNames.filter(
      (toolName) => !availableToolNamesSet.has(toolName)
    ),
    unknownDisallowedToolNames: disallowedToolNames.filter(
      (toolName) => !availableToolNamesSet.has(toolName)
    ),
  };
}

export { DEFAULT_SCOPE_POLICY };
