import type { AgentDefinition } from './agent-definition';
import { normalizeAgentDefinition } from './agent-definition';
import type { AgentDefinitionLoadError } from './agent-loader';
import { loadProjectAgentDefinitions } from './agent-loader';

export interface AgentRegistry {
  allAgents: AgentDefinition[];
  activeAgents: AgentDefinition[];
  failedFiles: AgentDefinitionLoadError[];
  getActiveAgent(agentType: string): AgentDefinition | undefined;
}

export interface AgentRegistryInput {
  builtIn?: unknown[];
  plugin?: unknown[];
  user?: unknown[];
  project?: unknown[];
  failedFiles?: AgentDefinitionLoadError[];
}

export interface LoadAgentRegistryOptions extends AgentRegistryInput {
  projectRoot?: string;
}

export function createAgentRegistry(input: AgentRegistryInput = {}): AgentRegistry {
  const allAgents = [
    ...(input.builtIn ?? []),
    ...(input.plugin ?? []),
    ...(input.user ?? []),
    ...(input.project ?? []),
  ].map((definition) => normalizeAgentDefinition(definition));
  const activeByType = new Map<string, AgentDefinition>();

  for (const agent of allAgents) {
    activeByType.set(agent.agentType, agent);
  }

  return {
    allAgents,
    activeAgents: Array.from(activeByType.values()),
    failedFiles: input.failedFiles ?? [],
    getActiveAgent(agentType: string): AgentDefinition | undefined {
      return activeByType.get(agentType);
    },
  };
}

export async function loadAgentRegistry(
  options: LoadAgentRegistryOptions = {}
): Promise<AgentRegistry> {
  const projectLoadResult = options.projectRoot
    ? await loadProjectAgentDefinitions(options.projectRoot)
    : { definitions: [], failedFiles: [] };

  return createAgentRegistry({
    builtIn: options.builtIn,
    plugin: options.plugin,
    user: options.user,
    project: [...(options.project ?? []), ...projectLoadResult.definitions],
    failedFiles: [...(options.failedFiles ?? []), ...projectLoadResult.failedFiles],
  });
}
