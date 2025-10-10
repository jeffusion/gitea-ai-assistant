import {
  AgentType,
  AgentResult,
  ComprehensiveReviewResult,
  GlobalReviewState,
} from './types';

/**
 * 统一的错误处理模块，用于捕获和处理Agent执行失败等异常情况。
 */
export class ErrorHandler {
  /**
   * 处理Agent执行过程中发生的错误。
   *
   * @param agentType 发生错误的Agent类型
   * @param error 捕获到的Error对象
   * @param context 发生错误时的上下文信息
   * @returns 一个表示失败的AgentResult，其中包含降级策略的结果
   */
  public static handleAgentError(
    agentType: AgentType,
    error: Error,
    context: any,
  ): AgentResult {
    // 记录详细的错误日志
    console.error(`[ErrorHandler] Agent ${agentType} failed:`, {
      errorMessage: error.message,
      errorStack: error.stack,
      context,
    });

    // 根据失败的agentType，实现不同的降级策略
    switch (agentType) {
      // 对于关键的编排或全局分析Agent失败，直接向上抛出异常
      case AgentType.ORCHESTRATOR:
      case AgentType.GLOBAL_CONTEXT_ANALYZER:
        throw new Error(
          `Critical agent ${agentType} failed: ${error.message}`,
        );

      // 对于安全扫描Agent失败，返回一个高风险、低置信度的结果
      case AgentType.SECURITY_SCANNER:
        return {
          output: {
            findings: [],
            riskLevel: 'high',
            summary: '安全扫描Agent执行失败，无法评估代码安全性。',
          },
          confidence: 0.1, // 低置信度
          metadata: {
            processingTime: 0,
            tokensUsed: 0,
            errors: [`Security scanner failed: ${error.message}`],
          },
        };

      // 对于其他非关键Agent，返回一个置信度为0的结果
      default:
        return {
          output: [],
          confidence: 0,
          metadata: {
            processingTime: 0,
            tokensUsed: 0,
            errors: [`Agent ${agentType} failed: ${error.message}`],
          },
        };
    }
  }
  public static handleFrameworkError(
    error: Error,
    state: GlobalReviewState,
  ): ComprehensiveReviewResult {
    console.error(
      '[ErrorHandler] A critical error occurred in the AgentFramework:',
      error,
    );
    return {
      summary: `Code review failed due to a critical system error: ${error.message}`,
      overallScore: 0,
      riskLevel: 'high',
      findings: {
        security: [],
        quality: [],
        complexity: [],
        language: [],
      },
      lineComments: [],
      recommendations: {
        critical: [
          'The automated review could not be completed. Please review the code manually and check system logs.',
        ],
        high: [],
        medium: [],
        low: [],
      },
      metadata: {
        totalFilesAnalyzed: Object.keys(state.fileAnalysis).length,
        totalAgentsUsed: 0,
        averageConfidence: 0,
        processingTime: 0, // Or calculate elapsed time if possible
        uncertainAreas: [
          'The entire review is uncertain due to system failure.',
        ],
      },
    };
  }
}
