import {
  AgentResult,
  AgentType,
  BaseAgent,
  FileAnalysisData,
  GlobalReviewState,
  SecurityFinding,
} from '../types';
import * as fs from 'fs';
import * as path from 'path';

interface SecurityRule {
  name: string;
  pattern: RegExp;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  recommendation: string;
  cweId?: string;
  confidence?: number;
}

export class SecurityScannerAgent extends BaseAgent {
  type: AgentType = AgentType.SECURITY_SCANNER;
  description: string = 'Scans for security vulnerabilities.';
  private securityRules: SecurityRule[];

  constructor() {
    super();
    this.securityRules = this.loadSecurityRules();
  }

  async process(
    file: FileAnalysisData,
    state: GlobalReviewState,
  ): Promise<AgentResult> {
    const startTime = Date.now();
    const findings: SecurityFinding[] = [];

    for (const rule of this.securityRules) {
      const lines = file.rawContent.split('\n');
      lines.forEach((lineContent: string, index: number) => {
        let match;
        // Must reset lastIndex for global regexes to work correctly in a loop
        rule.pattern.lastIndex = 0;
        while ((match = rule.pattern.exec(lineContent)) !== null) {
          const finding: SecurityFinding = {
            type: 'security',
            severity: rule.severity,
            rule: rule.name,
            message: rule.message,
            filePath: file.filePath,
            lines: [index + 1],
            evidence: [match[0]],
            recommendation: rule.recommendation,
            cweId: rule.cweId,
            confidence: rule.confidence || 0.8,
          };
          findings.push(finding);
        }
      });
    }

    const overallConfidence =
      findings.length > 0
        ? findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length
        : 1.0;

    return {
      output: findings,
      confidence: parseFloat(overallConfidence.toFixed(2)),
      metadata: {
        processingTime: Date.now() - startTime,
        tokensUsed: 0, // Rule-based, no tokens used
        rulesApplied: this.securityRules.map(r => r.name),
      },
    };
  }

  private loadSecurityRules(): SecurityRule[] {
    try {
      const filePath = path.join(
        __dirname,
        '../../config/security-rules.json',
      );
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const rulesData = JSON.parse(fileContent);
      return rulesData.map((rule: any) => ({
        ...rule,
        pattern: new RegExp(rule.pattern, 'gi'),
      }));
    } catch (error) {
      console.error('Failed to load security rules:', error);
      return []; // Return empty array on failure
    }
  }
}
