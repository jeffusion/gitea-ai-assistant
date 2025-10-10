import {
  AgentResult,
  AgentType,
  BaseAgent,
  GlobalReviewState,
  SecurityFinding,
  QualityIssue,
  ComprehensiveReviewResult,
  AgentState,
  ComplexityMetric,
  LanguageInsight,
} from '../types';
import { parseDiffHunks } from '../../utils/diffParser';

const HIGH_COMPLEXITY_THRESHOLD = 30;

const SEVERITY_ORDER: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export class RefinementSynthesisAgent extends BaseAgent {
  type = AgentType.REFINEMENT_SYNTHESIS;
  description =
    'Synthesizes analysis from all agents into a structured, comprehensive report.';

  async process(state: GlobalReviewState): Promise<AgentResult> {
    const changedLines = parseDiffHunks(state.prContext.diffContent);

    let securityFindings: SecurityFinding[] = [];
    let qualityIssues: QualityIssue[] = [];
    const allComplexityMetrics: ComplexityMetric[] = [];
    let languageInsights: LanguageInsight[] = [];
    const changeSummaries: Record<string, any> = {};

    for (const file of Object.values(state.fileAnalysis)) {
      if (file.analysisResults) {
        const diffAnalystResult = file.analysisResults[AgentType.DIFF_ANALYST];
        if (diffAnalystResult) {
          changeSummaries[file.filePath] = diffAnalystResult;
        }

        const securityResults = file.analysisResults[AgentType.SECURITY_SCANNER] as
          | SecurityFinding[]
          | undefined;
        if (securityResults) {
          securityFindings.push(...securityResults);
        }

        const qualityResults = file.analysisResults[AgentType.QUALITY_CHECKER] as
          | QualityIssue[]
          | undefined;
        if (qualityResults) {
          qualityIssues.push(...qualityResults);
        }

        const complexityResult = file.analysisResults[AgentType.COMPLEXITY_ANALYZER] as
          | ComplexityMetric
          | undefined;
        if (complexityResult) {
          allComplexityMetrics.push(complexityResult);
        }

        const languageInsightResult = file.analysisResults[
          AgentType.TYPESCRIPT_SPECIALIST
        ] as LanguageInsight | undefined;
        if (languageInsightResult) {
          languageInsights.push(languageInsightResult);
        }

        const pythonInsightResult = file.analysisResults[
          AgentType.PYTHON_SPECIALIST
        ] as LanguageInsight | undefined;
        if (pythonInsightResult) {
          languageInsights.push(pythonInsightResult);
        }

        const javaInsightResult = file.analysisResults[
          AgentType.JAVA_SPECIALIST
        ] as LanguageInsight | undefined;
        if (javaInsightResult) {
          languageInsights.push(javaInsightResult);
        }

        const goInsightResult = file.analysisResults[
          AgentType.GO_SPECIALIST
        ] as LanguageInsight | undefined;
        if (goInsightResult) {
          languageInsights.push(goInsightResult);
        }
      }
    }

    securityFindings = this.filterFindingsByDiff(securityFindings, changedLines);
    qualityIssues = this.filterFindingsByDiff(qualityIssues, changedLines);
    languageInsights = this.filterFindingsByDiff(languageInsights, changedLines);

    const allFindings = [
      ...securityFindings.map(f => ({ ...f, originalType: 'security' })),
      ...qualityIssues.map(f => ({ ...f, originalType: 'quality' })),
      ...languageInsights.flatMap(insight => [
        ...insight.patterns.idioms.map(p => ({ ...p, originalType: 'language', subType: 'idioms' })),
        ...insight.patterns.antiPatterns.map(p => ({ ...p, originalType: 'language', subType: 'antiPatterns' })),
        ...insight.patterns.bestPractices.map(p => ({ ...p, originalType: 'language', subType: 'bestPractices' })),
      ]),
    ];

    const deduplicatedFindings = this.deduplicateFindings(allFindings);

    const finalSecurityFindings = deduplicatedFindings.filter(
      f => f.originalType === 'security'
    ) as SecurityFinding[];
    const finalQualityIssues = deduplicatedFindings.filter(
      f => f.originalType === 'quality'
    ) as QualityIssue[];
    const finalLanguagePatterns = deduplicatedFindings.filter(
      f => f.originalType === 'language'
    );

    // Reconstruct languageInsights
    const finalLanguageInsights: LanguageInsight[] = [];
    const languageInsightsByFile: Record<string, LanguageInsight> = {};

    for (const pattern of finalLanguagePatterns) {
      // Find the original insight this pattern belonged to
      const originalInsight = languageInsights.find(insight =>
        [
          ...insight.patterns.idioms,
          ...insight.patterns.antiPatterns,
          ...insight.patterns.bestPractices,
        ].some(p => p.line === pattern.line && p.filePath === pattern.filePath)
      );

      if (originalInsight) {
        if (!languageInsightsByFile[pattern.filePath]) {
          // Initialize a new insight for this file if it doesn't exist
          languageInsightsByFile[pattern.filePath] = {
            ...originalInsight, // Copy metadata like filePath, language
            patterns: { idioms: [], antiPatterns: [], bestPractices: [] },
          };
        }

        // Add the pattern to the correct category
        const subType = (pattern as any).subType as keyof LanguageInsight['patterns'];
        if (subType && languageInsightsByFile[pattern.filePath].patterns[subType]) {
          (languageInsightsByFile[pattern.filePath].patterns[subType] as any[]).push(pattern);
        }
      }
    }
    finalLanguageInsights.push(...Object.values(languageInsightsByFile));


    const synthesisOutput = {
      securityFindings: finalSecurityFindings,
      qualityIssues: finalQualityIssues,
      complexityMetrics: allComplexityMetrics,
      languageInsights: finalLanguageInsights,
    };

    // Store intermediate results in the state
    state.intermediateResults = {
      ...state.intermediateResults,
      ...synthesisOutput,
    };

    return {
      output: synthesisOutput,
      confidence: 1.0,
      metadata: {
        processingTime: 0, // Placeholder
        tokensUsed: 0, // Placeholder
      },
    };
  }


  private deduplicateFindings(allFindings: any[]): any[] {
    const findingsMap = new Map<string, any>();

    for (const finding of allFindings) {
      if (finding.line === undefined) {
        continue; // Skip findings without a line number
      }
      const key = `${finding.filePath}:${finding.line}`;
      const existingFinding = findingsMap.get(key);
      const currentSeverity = SEVERITY_ORDER[finding.severity] || 0;

      if (!existingFinding) {
        findingsMap.set(key, finding);
      } else {
        const existingSeverity = SEVERITY_ORDER[existingFinding.severity] || 0;
        if (currentSeverity > existingSeverity) {
          findingsMap.set(key, finding);
        }
      }
    }

    return Array.from(findingsMap.values());
  }

  private filterFindingsByDiff<T extends { filePath: string; line?: number; lines?: number[] }>(
    findings: T[],
    changedLines: Record<string, { addedLines: number[] }>,
  ): T[] {
    return findings.filter(finding => {
      const fileChangedLines = changedLines[finding.filePath];
      if (!fileChangedLines) {
        return false; // File not in diff, so finding is not relevant
      }

      const findingLine = finding.line ?? (finding.lines ? finding.lines : undefined);
      if (findingLine === undefined) {
        return true; // Keep findings without line numbers (e.g., file-level)
      }

      if (Array.isArray(findingLine)) {
        return findingLine.some(l => fileChangedLines.addedLines.includes(l));
      }
      return fileChangedLines.addedLines.includes(findingLine);
    });
  }

  private calculateAverageConfidence(agentStates: Record<string, AgentState>): number {
    const confidences = Object.values(agentStates)
      .map(s => s.metadata.confidence)
      .filter(c => c !== undefined);

    if (confidences.length === 0) {
      return 0;
    }

    const sum = confidences.reduce((acc, curr) => acc + curr, 0);
    return sum / confidences.length;
  }
}

