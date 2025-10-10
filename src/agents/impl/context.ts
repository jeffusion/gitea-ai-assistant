import { BaseAgent, AgentResult, AgentType, PRContext } from '../types';
import { GlobalReviewState } from '../state';

export class GlobalContextAnalyzerAgent extends BaseAgent {
  type = AgentType.GLOBAL_CONTEXT_ANALYZER;
  description =
    'Analyzes the global context of the PR to identify cross-file dependencies.';

  async process(
    state: GlobalReviewState,
  ): Promise<AgentResult> {
    const dependencies: { [key: string]: string[] } = {};
    const dependents: { [key: string]: string[] } = {};
    const startTime = Date.now();

    for (const filePath in state.fileAnalysis) {
      const fileData = state.fileAnalysis[filePath];
      if (!fileData) continue;

      const fileContent = fileData.rawContent;
      const fileDependencies = new Set<string>();

      // Regex to find import/require paths. Using non-greedy matching.
      const importRegex = /import\s+.*\s+from\s+['"](.*?)['"]/g;
      const requireRegex = /require\(['"](.*?)['"]\)/g;

      let match;
      while ((match = importRegex.exec(fileContent)) !== null) {
        if (match && match) {
          fileDependencies.add(match[1]);
        }
      }

      while ((match = requireRegex.exec(fileContent)) !== null) {
        if (match && match) {
          fileDependencies.add(match[1]);
        }
      }

      if (fileDependencies.size > 0) {
        const depsArray = Array.from(fileDependencies);
        dependencies[filePath] = depsArray;
        for (const dep of depsArray) {
          if (!dependents[dep]) {
            dependents[dep] = [];
          }
          dependents[dep].push(filePath);
        }
      }
    }

    state.crossFileDependencies = { dependencies, dependents };
    const processingTime = Date.now() - startTime;

    return {
      output: {
        message: 'Global context analysis complete.',
        dependencies,
        dependents,
      },
      confidence: 0.9,
      metadata: {
        processingTime,
        tokensUsed: 0,
      },
    };
  }
}
