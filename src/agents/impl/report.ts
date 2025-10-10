import {
  AgentResult,
  AgentType,
  BaseAgent,
  ComprehensiveReviewResult,
  GlobalReviewState,
  SecurityFinding,
  QualityIssue,
  ComplexityMetric,
  LanguageInsight,
} from '../types';

interface SynthesisAgentOutput {
  securityFindings: SecurityFinding[];
  qualityIssues: QualityIssue[];
  complexityMetrics: ComplexityMetric[];
  languageInsights: LanguageInsight[];
}

export class FinalReportGeneratorAgent extends BaseAgent {
  type: AgentType = AgentType.FINAL_REPORT_GENERATOR;
  description: string = 'Generates the final comprehensive report from synthesized findings.';

  async process(
    input: SynthesisAgentOutput,
    state: GlobalReviewState,
  ): Promise<AgentResult> {
    const { securityFindings, qualityIssues, complexityMetrics, languageInsights } = input;

    // 1. 生成摘要
    const summary = this.generateSummary(input);

    // 2. 生成推荐
    const recommendations = this.generateRecommendations(input);

    // 3. 组装结果 (简化)
    const finalResult: ComprehensiveReviewResult = {
      summary,
      overallScore: 8, // 简化：暂时使用固定值
      riskLevel: 'medium', // 简化：暂时使用固定值
      findings: {
        security: securityFindings,
        quality: qualityIssues,
        complexity: complexityMetrics,
        language: languageInsights,
      },
      lineComments: [], // 简化：暂时为空
      recommendations,
      metadata: {
        totalFilesAnalyzed: Object.keys(state.fileAnalysis).length,
        totalAgentsUsed: Object.keys(state.agentStates).length,
        averageConfidence: 0.9, // 简化：暂时使用固定值
        processingTime: (Date.now() - new Date(state.prContext.createdAt).getTime()) / 1000,
      },
    };

    return {
      output: finalResult,
      confidence: 1.0,
      metadata: {
        processingTime: 0,
        tokensUsed: 0,
      },
    };
  }

  private generateSummary(input: SynthesisAgentOutput): string {
    const { securityFindings, qualityIssues, complexityMetrics } = input;
    const totalIssues = securityFindings.length + qualityIssues.length;

    if (totalIssues === 0) {
      return '本次代码审查未发现任何主要问题。代码质量良好，结构清晰。';
    }

    let summaryText = `本次代码审查共发现 ${totalIssues} 个主要问题。\n`;
    if (securityFindings.length > 0) {
      summaryText += `*   **安全方面**: 发现了 ${securityFindings.length} 个潜在漏洞，需要重点关注。\n`;
    }
    if (qualityIssues.length > 0) {
      summaryText += `*   **代码质量**: 识别出 ${qualityIssues.length} 个质量问题，涉及可维护性和代码风格。\n`;
    }
    if (complexityMetrics.length > 0) {
      const avgComplexity =
        complexityMetrics.reduce((acc, m) => acc + m.cognitiveComplexity, 0) /
        complexityMetrics.length;
      summaryText += `*   **代码复杂度**: 分析了 ${complexityMetrics.length} 个文件，平均认知复杂度为 ${avgComplexity.toFixed(2)}。\n`;
    }
    summaryText += '请查看下面的详细建议以进行改进。';
    return summaryText;
  }

  private generateRecommendations(input: SynthesisAgentOutput): ComprehensiveReviewResult['recommendations'] {
    const recommendations: ComprehensiveReviewResult['recommendations'] = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };

    // 将最严重的安全问题作为推荐
    input.securityFindings
      .slice()
      .sort((a, b) => {
        const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        return severityOrder[b.severity] - severityOrder[a.severity];
      })
      .slice(0, 3) // 最多取3个
      .forEach(finding => {
        const message = `[安全] ${finding.message} (文件: ${finding.filePath}, 行: ${finding.lines.join(', ')})`;
        if (finding.severity === 'critical' || finding.severity === 'high') {
          recommendations.high.push(message);
        } else {
          recommendations.medium.push(message);
        }
      });

    // 将最严重的质量问题作为推荐
    input.qualityIssues
      .slice()
      .sort((a, b) => {
        const severityOrder = { high: 3, medium: 2, low: 1 };
        return severityOrder[b.severity] - severityOrder[a.severity];
      })
      .slice(0, 2) // 最多取2个
      .forEach(issue => {
        const message = `[质量] ${issue.message} (文件: ${issue.filePath}, 行: ${issue.line})`;
        recommendations.medium.push(message);
      });

    return recommendations;
  }
}
