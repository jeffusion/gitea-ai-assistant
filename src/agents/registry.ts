import { BaseAgent, AgentType } from './types';
import { OrchestratorAgent } from './orchestrator';
import { QualityCheckerAgent } from './impl/quality';
import { SecurityScannerAgent } from './impl/security';
import { RefinementSynthesisAgent } from './impl/synthesis';
import { GlobalContextAnalyzerAgent } from './impl/context';
import { ComplexityAnalyzerAgent } from './impl/complexity';
import { TypeScriptSpecialistAgent } from './impl/typescript';
import { PythonSpecialistAgent } from './impl/python';
import { JavaSpecialistAgent } from './impl/java';
import { GoSpecialistAgent } from './impl/go';
import { DiffAnalystAgent } from './impl/diff';
import { FinalReportGeneratorAgent } from './impl/report';

/**
 * AgentRegistry is a singleton class that manages all agent instances in the system.
 * It provides methods to register, discover, and manage agents.
 */
export class AgentRegistry {
  private static instance: AgentRegistry;
  private agents: Map<AgentType, BaseAgent> = new Map();

  private constructor() {
    // Private constructor to prevent direct instantiation.
  }

  /**
   * Returns the singleton instance of the AgentRegistry.
   * @returns The singleton instance.
   */
  public static getInstance(): AgentRegistry {
    if (!AgentRegistry.instance) {
      AgentRegistry.instance = new AgentRegistry();
    }
    return AgentRegistry.instance;
  }

  /**
   * Registers a new agent instance.
   * @param agent - The agent instance to register.
   */
  public register(agent: BaseAgent): void {
    if (this.agents.has(agent.type)) {
      console.warn(`Agent with type ${agent.type} is already registered. Overwriting.`);
    }
    this.agents.set(agent.type, agent);
  }

  /**
   * Retrieves an agent instance by its type.
   * @param type - The type of the agent to retrieve.
   * @returns The agent instance, or undefined if not found.
   */
  public get(type: AgentType): BaseAgent | undefined {
    return this.agents.get(type);
  }

  /**
   * Lists all registered agent instances.
   * @returns An array of all registered agents.
   */
  public list(): BaseAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Performs a health check on a specific agent.
   * @param type - The type of the agent to check.
   * @returns A promise that resolves with the health status.
   */
  public async healthCheck(type: AgentType): Promise<{ healthy: boolean; message?: string }> {
    const agent = this.get(type);
    if (!agent) {
      return { healthy: false, message: `Agent with type ${type} not found.` };
    }

    try {
      return await agent.healthCheck();
    } catch (error) {
      return { healthy: false, message: error instanceof Error ? error.message : 'An unknown error occurred.' };
    }
  }
}

export const agentRegistry = AgentRegistry.getInstance();

// Register all agents here
agentRegistry.register(new OrchestratorAgent());
agentRegistry.register(new GlobalContextAnalyzerAgent());
agentRegistry.register(new SecurityScannerAgent());
agentRegistry.register(new QualityCheckerAgent());
agentRegistry.register(new ComplexityAnalyzerAgent());
agentRegistry.register(new RefinementSynthesisAgent());
agentRegistry.register(new TypeScriptSpecialistAgent());
agentRegistry.register(new PythonSpecialistAgent());
agentRegistry.register(new JavaSpecialistAgent());
agentRegistry.register(new GoSpecialistAgent());
agentRegistry.register(new DiffAnalystAgent());
agentRegistry.register(new FinalReportGeneratorAgent());
