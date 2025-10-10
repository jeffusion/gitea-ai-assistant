import { agentRegistry } from './registry';
import {
  AgentResult,
  AgentType,
  BaseAgent,
  GlobalReviewState,
} from './types';

export class OrchestratorAgent extends BaseAgent {
  type: AgentType = AgentType.ORCHESTRATOR;
  description: string = 'Orchestrates the code review process by dispatching tasks to other agents.';

  async process(state: GlobalReviewState): Promise<AgentResult> {
    const filePaths = Object.keys(state.fileAnalysis);
    const { dependents } = state.crossFileDependencies;

    for (const filePath of filePaths) {
      const fileData = state.fileAnalysis[filePath];
      const scheduledAgents = new Set<AgentType>();

      // Base scheduling on file type
      if (fileData.language === 'typescript' || fileData.language === 'javascript') {
        scheduledAgents.add(AgentType.QUALITY_CHECKER);
        scheduledAgents.add(AgentType.SECURITY_SCANNER);
        scheduledAgents.add(AgentType.TYPESCRIPT_SPECIALIST);
      } else if (fileData.language === 'python') {
        scheduledAgents.add(AgentType.QUALITY_CHECKER);
        scheduledAgents.add(AgentType.SECURITY_SCANNER);
        scheduledAgents.add(AgentType.PYTHON_SPECIALIST);
      } else if (fileData.language === 'java') {
        scheduledAgents.add(AgentType.QUALITY_CHECKER);
        scheduledAgents.add(AgentType.SECURITY_SCANNER);
        scheduledAgents.add(AgentType.JAVA_SPECIALIST);
      } else if (fileData.language === 'go') {
        scheduledAgents.add(AgentType.QUALITY_CHECKER);
        scheduledAgents.add(AgentType.SECURITY_SCANNER);
        scheduledAgents.add(AgentType.GO_SPECIALIST);
      }

      // Schedule complexity analysis for all files
      scheduledAgents.add(AgentType.COMPLEXITY_ANALYZER);
      scheduledAgents.add(AgentType.DIFF_ANALYST);

      // Rule 1: If a file is a dependency for many others, it's a core file.
      const dependentCount = dependents[filePath]?.length || 0;
      if (dependentCount > 2) {
        console.log(`File ${filePath} is a core file (${dependentCount} dependents).`);
      }

      // Execute agents for the current file
      const analysisResults: Partial<Record<AgentType, any>> = {};
      for (const agentType of scheduledAgents) {
        const agent = agentRegistry.get(agentType);
        if (agent) {
          const result = await agent.process(fileData, state);
          analysisResults[agentType] = result.output;
        } else {
          console.warn(`Agent with type ${agentType} not found in registry.`);
        }
      }
      state.fileAnalysis[filePath].analysisResults = analysisResults;
    }

    const totalAgentsDispatched = Object.values(state.fileAnalysis).reduce(
      (sum, file) => sum + Object.keys(file.analysisResults || {}).length,
      0,
    );

    return {
      output: {
        message: `Orchestrator dispatched a total of ${totalAgentsDispatched} analysis tasks across ${filePaths.length} files.`,
      },
      confidence: 0.9, // High confidence in orchestration logic itself
      metadata: {
        processingTime: 0, // This should be calculated properly
        tokensUsed: 0,
      },
    };
  }
}
