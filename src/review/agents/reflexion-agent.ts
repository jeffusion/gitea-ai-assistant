import OpenAI from 'openai';
import { SpecialistAgent } from './specialist-agent';
import { CriticAgent, CritiqueResult } from './critic-agent';
import { AgentResult, FindingCategory, ReviewContext, ReviewRun, Finding } from '../types';
import { ToolRegistry } from '../tools/registry';
import { LearningSystem } from '../learning/learning-system';
import { logger } from '../../utils/logger';
import { findingResponseSchema } from '../schema/finding-schema';
import { createHash } from 'node:crypto';

function buildFingerprint(category: string, path: string, line: number, title: string): string {
  return createHash('sha256').update(`${category}:${path}:${line}:${title}`).digest('hex').slice(0, 24);
}

export class ReflexionAgent extends SpecialistAgent {
  private criticAgent: CriticAgent;

  constructor(
    openai: OpenAI,
    model: string,
    category: FindingCategory,
    agentName: string,
    focusPrompt: string,
    toolRegistry?: ToolRegistry,
    learningSystem?: LearningSystem
  ) {
    super(openai, model, category, agentName, focusPrompt, toolRegistry, learningSystem);
    this.criticAgent = new CriticAgent(openai, model);
  }

  async reviewWithReflection(
    run: ReviewRun,
    context: ReviewContext,
    maxReflectionRounds: number = 2
  ): Promise<AgentResult> {
    let bestFindings: Omit<Finding, 'id' | 'runId' | 'published'>[] = [];
    let bestQualityScore = 0;
    let currentFindings: Omit<Finding, 'id' | 'runId' | 'published'>[] = [];

    for (let round = 0; round < maxReflectionRounds; round++) {
      logger.info(`${this.agentName} Reflection Round ${round + 1}/${maxReflectionRounds}`, {
        runId: run.id,
      });

      // 生成初步findings（首轮或基于上一轮refined结果）
      const draft = await this.generateDraft(run, context, currentFindings, round);

      // 自我批评
      const critique = await this.criticAgent.critique(draft, context);

      logger.info(`${this.agentName} Critique结果`, {
        runId: run.id,
        round: round + 1,
        qualityScore: critique.qualityScore,
        issuesFound: critique.issues.length,
        missedIssues: critique.missedIssues.length,
      });

      // 如果质量已经很好，提前结束并保存最佳结果
      if (critique.qualityScore >= 0.9 && critique.issues.length === 0) {
        bestFindings = draft;
        bestQualityScore = critique.qualityScore;
        logger.info(`${this.agentName} 质量满足要求，提前结束Reflection`, {
          runId: run.id,
          finalScore: critique.qualityScore,
        });
        break;
      }

      // 如果这轮质量更好，保存为最佳结果
      if (critique.qualityScore > bestQualityScore) {
        bestQualityScore = critique.qualityScore;
        bestFindings = draft;
      }

      // 如果还有改进空间，继续优化（refine后需要在下一轮重新评估）
      if (round < maxReflectionRounds - 1) {
        currentFindings = await this.refine(draft, critique, context, run);
      }
    }

    return {
      agentName: this.agentName,
      findings: bestFindings,
    };
  }

  private async generateDraft(
    run: ReviewRun,
    context: ReviewContext,
    previousFindings: Omit<Finding, 'id' | 'runId' | 'published'>[],
    round: number
  ): Promise<Omit<Finding, 'id' | 'runId' | 'published'>[]> {
    // 第一轮：使用父类的review方法
    if (round === 0) {
      const result = await super.review(run, context);
      return result.findings;
    }

    // 后续轮次：在前一轮基础上改进（由refine方法生成）
    return previousFindings;
  }

  private async refine(
    draft: Omit<Finding, 'id' | 'runId' | 'published'>[],
    critique: CritiqueResult,
    context: ReviewContext,
    run: ReviewRun
  ): Promise<Omit<Finding, 'id' | 'runId' | 'published'>[]> {
    const prompt = `你是${this.agentName}。根据以下批评意见，改进审查结果。

原始findings（${draft.length}个）：
${JSON.stringify(draft, null, 2)}

Critic Agent的批评意见：
质量评分: ${critique.qualityScore}
发现的问题（${critique.issues.length}个）:
${critique.issues.map((issue) => `- Finding #${issue.findingIndex}: ${issue.problem}\n  建议: ${issue.suggestion}`).join('\n')}

可能遗漏的问题（${critique.missedIssues.length}个）:
${critique.missedIssues.map((missed) => `- ${missed}`).join('\n')}

总体评估: ${critique.overallAssessment}

代码上下文：
${context.diff.slice(0, 3000)}

任务：
1. 修正有问题的findings（根据批评意见）
2. 补充遗漏的问题（如果确实存在）
3. 移除误报
4. 提升evidence的充分性和具体性

返回改进后的findings JSON数组，格式：
{
  "findings": [...]
}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `你是${this.agentName}，根据批评反馈改进审查结果。`,
          },
          { role: 'user', content: prompt },
        ],
      });

      const content = response.choices[0]?.message.content;
      if (!content) {
        logger.warn(`${this.agentName} Refine返回空结果，使用原findings`);
        return draft;
      }

      const parsed = JSON.parse(content);

      // 使用schema验证refined findings，防止畸形数据流入发布系统
      const validated = findingResponseSchema.parse({ findings: parsed.findings || draft });

      // 标准化category和fingerprint
      return validated.findings.map((finding) => ({
        ...finding,
        category: this.category,
        fingerprint: finding.fingerprint || buildFingerprint(this.category, finding.path, finding.line, finding.title),
      }));
    } catch (error) {
      logger.error(`${this.agentName} Refine失败`, {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return draft; // 失败时返回原findings
    }
  }
}
