import {
  AgentResult,
  AgentType,
  BaseAgent,
  FileAnalysisData,
  GlobalReviewState,
  ComplexityMetric,
} from '../types';

export class ComplexityAnalyzerAgent extends BaseAgent {
  type: AgentType = AgentType.COMPLEXITY_ANALYZER;
  description: string = 'Analyzes code complexity and maintainability.';

  async process(
    file: FileAnalysisData,
    state: GlobalReviewState,
  ): Promise<AgentResult> {
    const startTime = Date.now();

    const linesOfCode = this.calculateLinesOfCode(file.rawContent);
    const cyclomaticComplexity = this.calculateCyclomaticComplexity(file.rawContent);
    const cognitiveComplexity = this.calculateCognitiveComplexity(file.rawContent);
    const maintainabilityIndex = this.calculateMaintainabilityIndex(
      linesOfCode,
      cyclomaticComplexity,
    );
    const technicalDebt = this.estimateTechnicalDebt(
      cyclomaticComplexity,
      cognitiveComplexity,
      maintainabilityIndex,
    );

    const metric: ComplexityMetric = {
      filePath: file.filePath,
      cyclomaticComplexity,
      cognitiveComplexity,
      linesOfCode,
      maintainabilityIndex,
      technicalDebt,
    };

    // Confidence is high because these are deterministic calculations
    const confidence = 0.99;

    return {
      output: metric,
      confidence,
      metadata: {
        processingTime: Date.now() - startTime,
        tokensUsed: 0, // No AI usage
        rulesApplied: ['cyclomatic_complexity', 'cognitive_complexity', 'maintainability_index'],
      },
    };
  }

  /**
   * Calculates the number of lines of code (excluding empty lines and comments).
   */
  private calculateLinesOfCode(content: string): number {
    const lines = content.split('\n');
    let loc = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('/*') &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('#') // Python/shebang comments
      ) {
        loc++;
      }
    }
    return loc;
  }

  /**
   * Calculates the cyclomatic complexity of the code.
   * It's a measure of the number of linearly independent paths through the code.
   */
  private calculateCyclomaticComplexity(content: string): number {
    // Decision points that increase complexity
    const complexityKeywords =
      /\b(if|else|while|for|foreach|switch|case|catch|&&|\|\||\?)\b/g;
    const matches = content.match(complexityKeywords);
    // Base complexity is 1 (for a single path)
    return (matches?.length || 0) + 1;
  }

  /**
   * Calculates the cognitive complexity.
   * This is a more nuanced metric that accounts for nesting and breaks in linear code flow.
   * This is a simplified implementation.
   */
  private calculateCognitiveComplexity(content: string): number {
    let complexity = 0;
    let nestingLevel = 0;
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Increment for nesting
      if (/\b(if|while|for|foreach|catch)\b/.test(trimmed)) {
        nestingLevel++;
        complexity += nestingLevel;
      }
      // Decrement after a block ends (simplified heuristic)
      if (trimmed === '}' || trimmed === 'end') {
        if (nestingLevel > 0) nestingLevel--;
      }

      // Increment for other logical operators
      if (/&&|\|\||\?/.test(trimmed)) {
        complexity += 1 + nestingLevel;
      }

      // Increment for break statements (like 'break', 'continue', 'return')
      if (/\b(break|continue|return)\b/.test(trimmed)) {
        complexity++;
      }
    }
    return complexity;
  }

  /**
   * Calculates the maintainability index.
   * A higher value indicates better maintainability.
   * Formula: 171 - 5.2 * ln(Halstead Volume) - 0.23 * (Cyclomatic Complexity) - 16.2 * ln(Lines of Code)
   * This is a simplified version using only Cyclomatic Complexity and LoC.
   */
  private calculateMaintainabilityIndex(loc: number, cc: number): number {
    if (loc === 0) return 100; // Empty file is perfectly maintainable

    // Simplified formula, often cited in research
    const index = Math.max(0, (171 - 5.2 * Math.log(loc) - 0.23 * cc - 16.2 * Math.log(loc)));

    // Scale to 0-100 for easier interpretation
    return Math.round((index / 171) * 100);
  }

  /**
   * Estimates technical debt in minutes based on complexity metrics.
   * This is a heuristic-based estimation.
   */
  private estimateTechnicalDebt(cc: number, cognitiveCc: number, maintainabilityIndex: number): { estimatedMinutes: number; issues: string[] } {
    const issues: string[] = [];
    let debtMinutes = 0;

    // High cyclomatic complexity indicates more debt
    if (cc > 20) {
      debtMinutes += (cc - 20) * 2;
      issues.push(`圈复杂度过高 (${cc})，建议重构。`);
    } else if (cc > 10) {
      debtMinutes += (cc - 10) * 1;
      issues.push(`圈复杂度较高 (${cc})，可考虑简化。`);
    }

    // High cognitive complexity also adds debt
    if (cognitiveCc > 15) {
      debtMinutes += (cognitiveCc - 15) * 3;
      issues.push(`认知复杂度过高 (${cognitiveCc})，代码难以理解。`);
    } else if (cognitiveCc > 10) {
      debtMinutes += (cognitiveCc - 10) * 1.5;
      issues.push(`认知复杂度较高 (${cognitiveCc})，可读性有待提升。`);
    }

    // Low maintainability index is a strong indicator of debt
    if (maintainabilityIndex < 20) {
      debtMinutes += 60; // Baseline 1 hour for very bad code
      issues.push(`可维护性指数极低 (${maintainabilityIndex})，需要大量重构工作。`);
    } else if (maintainabilityIndex < 50) {
      debtMinutes += 30;
      issues.push(`可维护性指数较低 (${maintainabilityIndex})，建议进行重构。`);
    }

    return {
      estimatedMinutes: Math.round(debtMinutes),
      issues,
    };
  }
}
