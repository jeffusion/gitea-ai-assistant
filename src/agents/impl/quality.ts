import {
  AgentResult,
  AgentType,
  BaseAgent,
  GlobalReviewState,
  FileAnalysisData,
  QualityIssue,
} from '../types';
import * as fs from 'fs';
import * as path from 'path';

interface QualityRule {
  name: string;
  pattern: RegExp;
  severity: 'low' | 'medium' | 'high';
  category: 'maintainability' | 'readability' | 'performance' | 'style';
  message: string;
  suggestion: string;
  languages: string[];
  confidence: number;
}

export class QualityCheckerAgent extends BaseAgent {
  type: AgentType = AgentType.QUALITY_CHECKER;
  description: string = 'Checks for code quality issues.';

  private qualityRules: QualityRule[];

  constructor() {
    super();
    this.qualityRules = this.loadQualityRules();
  }

  async process(
    file: FileAnalysisData,
    state: GlobalReviewState,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const issues: QualityIssue[] = [];

    for (const rule of this.qualityRules) {
      if (this.isRuleApplicable(rule, file.language)) {
        const lines = file.rawContent.split('\n');
        lines.forEach((lineContent, index) => {
          const matches = lineContent.match(rule.pattern);
          if (matches) {
            issues.push({
              type: 'quality',
              severity: rule.severity,
              category: rule.category,
              message: rule.message,
              filePath: file.filePath,
              line: index + 1,
              suggestion: rule.suggestion,
              confidence: this.calculateIssueConfidence(rule, matches),
            });
          }
        });
      }
    }

    return {
      output: issues,
      confidence: this.calculateConfidence(issues),
      metadata: {
        processingTime: Date.now() - startTime,
        tokensUsed: 0,
        rulesApplied: this.qualityRules.map(r => r.name),
      },
    };
  }

  private isRuleApplicable(rule: QualityRule, language: string): boolean {
    return rule.languages.length === 0 || rule.languages.includes(language);
  }

  private calculateConfidence(issues: QualityIssue[]): number {
    if (issues.length === 0) {
      return 0.95; // High confidence that there are no issues
    }
    // Simple average confidence for found issues
    const totalConfidence = issues.reduce(
      (sum, issue) => sum + issue.confidence,
      0,
    );
    const averageConfidence = totalConfidence / issues.length;
    return parseFloat(averageConfidence.toFixed(2));
  }

  private calculateIssueConfidence(
    rule: QualityRule,
    matches: string[],
  ): number {
    let confidence = rule.confidence;
    // Example heuristic: magic numbers are less certain if they are small
    if (rule.name === 'magic_numbers' && matches && matches.length > 0) {
      try {
        // We only check the first match for this simple heuristic
        const num = parseInt(matches[0], 10);
        if (!isNaN(num) && num < 10) {
          confidence -= 0.2;
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }
    return confidence;
  }

  private loadQualityRules(): QualityRule[] {
    try {
      const filePath = path.join(
        __dirname,
        '../../config/quality-rules.json',
      );
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const rulesData = JSON.parse(fileContent);
      return rulesData.map((rule: any) => ({
        ...rule,
        pattern: new RegExp(rule.pattern, 'gi'),
      }));
    } catch (error) {
      console.error('Failed to load quality rules:', error);
      return []; // Return empty array on failure
    }
  }
}
