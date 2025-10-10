import {
  AgentType,
  BaseAgent,
  AgentResult,
  FileAnalysisData,
  GlobalReviewState,
  LanguageInsight,
  PatternFinding,
} from '../types';
import { createAnalyzer, DiagnosticCategory } from 'pyright';

export class PythonSpecialistAgent extends BaseAgent {
  type: AgentType = AgentType.PYTHON_SPECIALIST;
  description: string = 'Provides in-depth analysis for Python code.';

  private async analyzePythonCode(
    code: string,
    filePath: string,
  ): Promise<PatternFinding[]> {
    const analyzer = createAnalyzer();
    analyzer.setSourceFile(filePath, code);
    const results = analyzer.getDiagnostics();

    const unusedImportFindings = results
      .filter(diag => diag.category === DiagnosticCategory.ReportUnusedImport)
      .map(
        diag =>
          ({
            message: diag.message,
            filePath,
            line: diag.range.start.line,
          } as PatternFinding),
      );

    return unusedImportFindings;
  }

  async process(
    fileData: FileAnalysisData,
    state: GlobalReviewState,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const unusedImports = await this.analyzePythonCode(
      fileData.rawContent,
      fileData.filePath,
    );

    const insight: LanguageInsight = {
      language: 'python',
      filePath: fileData.filePath,
      patterns: {
        idioms: [],
        antiPatterns: [],
        bestPractices: unusedImports,
      },
      dependencies: {
        direct: [],
        circular: [],
        unused: [],
      },
    };

    const processingTime = Date.now() - startTime;

    if (unusedImports.length > 0) {
      return {
        output: insight,
        confidence: 0.9,
        metadata: {
          processingTime,
          tokensUsed: 0,
          errors: [],
        },
      };
    } else {
      return {
        output: insight,
        confidence: 0.95,
        metadata: {
          processingTime,
          tokensUsed: 0,
          errors: [],
        },
      };
    }
  }
}
