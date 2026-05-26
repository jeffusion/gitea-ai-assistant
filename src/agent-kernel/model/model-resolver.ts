import type { AgentDefinition } from '../definitions';

export interface AgentModelResolutionInput {
  spawnOverride?: string;
  agentDefinition: Pick<AgentDefinition, 'model'>;
  defaultSubagentModel?: string;
  mainAgentModel: string;
}

export function resolveAgentModel(input: AgentModelResolutionInput): string {
  return (
    input.spawnOverride ??
    input.agentDefinition.model ??
    input.defaultSubagentModel ??
    input.mainAgentModel
  );
}
