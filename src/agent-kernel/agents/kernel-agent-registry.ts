import type { KernelSubagentDefinition } from '../types';

export class KernelAgentRegistry<TState> {
  private readonly agents = new Map<string, KernelSubagentDefinition<TState>>();

  register(agent: KernelSubagentDefinition<TState>): void {
    this.agents.set(agent.name, agent);
  }

  get(agentType: string): KernelSubagentDefinition<TState> | undefined {
    return this.agents.get(agentType);
  }

  getAll(): KernelSubagentDefinition<TState>[] {
    return [...this.agents.values()];
  }

  filterByTag(tag: string): KernelSubagentDefinition<TState>[] {
    return this.getAll().filter((agent) => agent.tags?.includes(tag));
  }
}
