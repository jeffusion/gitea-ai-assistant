import { BaseAgent, AgentType, AgentResult, FileAnalysisData, GlobalReviewState } from '../types';

export class DiffAnalystAgent extends BaseAgent {
  type: AgentType = AgentType.DIFF_ANALYST;
  description: string = "Analyzes code changes to classify the nature of the diff.";

  async process(fileData: FileAnalysisData, state: GlobalReviewState): Promise<AgentResult> {
    const diffContent = fileData.diffContent;
    let changeType = "General Fix";
    let confidence = 0.7;

    const hasAdditions = diffContent.split('\n').some(line => line.startsWith('+'));
    const hasDeletions = diffContent.split('\n').some(line => line.startsWith('-'));

    if (fileData.filePath.endsWith('.md')) {
      changeType = "Documentation";
    } else if (hasAdditions && !hasDeletions) {
      const additionLines = diffContent.split('\n').filter(line => line.startsWith('+'));
      if (additionLines.some(line => /\b(function|class|const|let)\b/.test(line))) {
        changeType = "Feature/Refactor";
      }
    } else if (hasDeletions && !hasAdditions) {
      changeType = "Deletion";
    }

    return {
      output: { changeType },
      confidence,
      metadata: {
        processingTime: 0,
        tokensUsed: 0,
      }
    };
  }
}
