import type { MainAgentTool } from '../loop';

export interface ResolveAgentToolsInput {
  availableTools: MainAgentTool[];
  allowedToolNames: string[];
  disallowedToolNames: string[];
}

export interface ResolvedAgentTools {
  tools: MainAgentTool[];
  allowedToolNames: string[];
  disallowedToolNames: string[];
  deniedToolNames: string[];
  unknownAllowedToolNames: string[];
  unknownDisallowedToolNames: string[];
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names)];
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
    return allowedToolNamesSet.has(toolName) && !disallowedToolNamesSet.has(toolName);
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
