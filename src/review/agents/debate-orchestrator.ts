import config from '../../config';
import type { LLMGateway } from '../../llm/gateway';
import type { LLMMessage } from '../../llm/types';
import { withGlobalPrompt } from '../../utils/global-prompt';
import { logger } from '../../utils/logger';
import { Finding, FindingSeverity } from '../types';
import { SpecialistAgent } from './specialist-agent';

interface AgentOpinion {
  agentName: string;
  confidence: number;
  severity: FindingSeverity;
  reasoning: string;
  isValid: boolean;
}

export class DebateOrchestrator {
  private gateway: LLMGateway;

  constructor(gateway: LLMGateway) {
    this.gateway = gateway;
  }

  async conductDebate(
    finding: Omit<Finding, 'id' | 'runId' | 'published'>,
    agents: SpecialistAgent[],
    maxRounds = 2
  ): Promise<Omit<Finding, 'id' | 'runId' | 'published'>> {
    if (agents.length < 2) {
      logger.debug('Debate需要至少2个agents，跳过');
      return finding;
    }

    logger.info('启动Debate', {
      finding: finding.title,
      agentsCount: agents.length,
      maxRounds,
    });

    const opinions = new Map<string, AgentOpinion>();

    // 收集初始意见
    for (const agent of agents) {
      const opinion = await this.getAgentOpinion(agent, finding);
      opinions.set((agent as any).agentName, opinion);
    }

    // 辩论轮次
    for (let round = 0; round < maxRounds; round++) {
      logger.debug(`Debate Round ${round + 1}/${maxRounds}`, {
        finding: finding.title,
      });

      for (const agent of agents) {
        const agentName = (agent as any).agentName;
        const otherOpinions = Array.from(opinions.entries()).filter(([name]) => name !== agentName);

        const revisedOpinion = await this.reviseOpinion(agent, finding, otherOpinions, opinions);

        opinions.set(agentName, revisedOpinion);
      }

      // 检查是否已达成共识
      if (this.hasConsensus(opinions)) {
        logger.info(`Debate在第${round + 1}轮达成共识`, {
          finding: finding.title,
        });
        break;
      }
    }

    // 形成共识
    return this.formConsensus(finding, opinions);
  }

  private async getAgentOpinion(
    agent: SpecialistAgent,
    finding: Omit<Finding, 'id' | 'runId' | 'published'>
  ): Promise<AgentOpinion> {
    const agentName = (agent as any).agentName;
    const prompt = `你是${agentName}。评估以下代码问题的严重性、置信度和有效性。

问题：
- Title: ${finding.title}
- Detail: ${finding.detail}
- Evidence: ${finding.evidence}
- Current Severity: ${finding.severity}
- Current Confidence: ${finding.confidence}

从你的专业角度判断：
1. 这个问题是否真实存在（不是误报）？
2. 严重性评估是否准确？
3. 你的置信度是多少？
4. 你的判断理由？

返回JSON：
{
  "is_valid": true/false,
  "confidence": 0.0-1.0,
  "severity": "high" | "medium" | "low",
  "reasoning": "你的判断理由（详细说明）"
}`;

    try {
      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: withGlobalPrompt(
            `你是${agentName}，从你的专业角度独立评估代码问题。`,
            config.review.globalPrompt
          ),
        },
        { role: 'user', content: prompt },
      ];

      const response = await this.gateway.chatForRole('specialist', {
        messages,
        temperature: 0.2,
        responseFormat: 'json',
      });

      const content = response.content;
      if (!content) {
        throw new Error('Agent opinion返回空');
      }

      const parsed = JSON.parse(content);

      return {
        agentName,
        // 使用 ?? 而非 ||，保留有效的0置信度（完全不确定/强烈拒绝）
        confidence: parsed.confidence ?? 0.5,
        severity: parsed.severity || 'medium',
        reasoning: parsed.reasoning || '',
        isValid: parsed.is_valid ?? true,
      };
    } catch (error) {
      logger.error(`获取${agentName}意见失败`, {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        agentName,
        confidence: finding.confidence,
        severity: finding.severity,
        reasoning: '获取意见失败，使用默认值',
        isValid: true,
      };
    }
  }

  private async reviseOpinion(
    agent: SpecialistAgent,
    finding: Omit<Finding, 'id' | 'runId' | 'published'>,
    otherOpinions: [string, AgentOpinion][],
    opinions: Map<string, AgentOpinion>
  ): Promise<AgentOpinion> {
    const agentName = (agent as any).agentName;
    const prompt = `你是${agentName}。重新评估以下问题，考虑其他专家的意见。

问题：
- Title: ${finding.title}
- Evidence: ${finding.evidence}

其他专家意见：
${otherOpinions
  .map(
    ([name, op]) =>
      `- ${name}: ${op.isValid ? '有效' : '误报'}, ${op.severity} (置信度 ${op.confidence.toFixed(2)})\n  理由: ${
        op.reasoning
      }`
  )
  .join('\n')}

基于同行的意见，你是否改变观点？

返回JSON：
{
  "is_valid": true/false,
  "confidence": 0.0-1.0,
  "severity": "high" | "medium" | "low",
  "reasoning": "修正后的理由或坚持原判断的原因"
}`;

    try {
      const messages: LLMMessage[] = [
        {
          role: 'system',
          content: withGlobalPrompt(
            `你是${agentName}，根据同行意见重新评估，但也要坚持你的专业判断。`,
            config.review.globalPrompt
          ),
        },
        { role: 'user', content: prompt },
      ];

      const response = await this.gateway.chatForRole('specialist', {
        messages,
        temperature: 0.3, // 允许一定灵活性
        responseFormat: 'json',
      });

      const content = response.content;
      if (!content) {
        throw new Error('Revised opinion返回空');
      }

      const parsed = JSON.parse(content);

      return {
        agentName,
        // 使用 ?? 而非 ||，保留有效的0置信度（完全不确定/强烈拒绝）
        confidence: parsed.confidence ?? 0.5,
        severity: parsed.severity || 'medium',
        reasoning: parsed.reasoning || '',
        isValid: parsed.is_valid ?? true,
      };
    } catch (error) {
      logger.error(`${agentName}修订意见失败`, {
        error: error instanceof Error ? error.message : String(error),
      });

      // 返回当前意见（从opinions Map中获取）
      const currentOpinion = opinions.get(agentName);
      return (
        currentOpinion || {
          agentName,
          confidence: 0.5,
          severity: 'medium',
          reasoning: '修订失败',
          isValid: true,
        }
      );
    }
  }

  private hasConsensus(opinions: Map<string, AgentOpinion>): boolean {
    const votes = Array.from(opinions.values());

    if (votes.length === 0) return true;

    // 检查有效性共识（至少80%同意）
    const validCount = votes.filter((v) => v.isValid).length;
    const validRatio = validCount / votes.length;

    if (validRatio >= 0.8 || validRatio <= 0.2) {
      return true; // 大多数同意有效或无效
    }

    // 检查严重性共识
    const severityCounts: Record<FindingSeverity, number> = {
      high: 0,
      medium: 0,
      low: 0,
    };

    votes.forEach((v) => {
      severityCounts[v.severity]++;
    });

    const maxCount = Math.max(...Object.values(severityCounts));
    const consensusRatio = maxCount / votes.length;

    return consensusRatio >= 0.7; // 70%同意同一严重性
  }

  private formConsensus(
    finding: Omit<Finding, 'id' | 'runId' | 'published'>,
    opinions: Map<string, AgentOpinion>
  ): Omit<Finding, 'id' | 'runId' | 'published'> {
    const votes = Array.from(opinions.values());

    if (votes.length === 0) {
      return finding;
    }

    // 判断有效性（投票）
    const validCount = votes.filter((v) => v.isValid).length;
    const isValid = validCount > votes.length / 2;

    // 如果被判定为无效，降低置信度
    if (!isValid) {
      logger.info('Debate判定为无效finding', {
        finding: finding.title,
        validVotes: validCount,
        totalVotes: votes.length,
      });

      return {
        ...finding,
        confidence: Math.min(finding.confidence, 0.4),
        detail: `${finding.detail}\n\n**Debate结果**: 多数专家认为此问题可能是误报（${validCount}/${votes.length}认为有效）`,
      };
    }

    // 计算平均置信度（仅计算认为有效的votes）
    const validVotes = votes.filter((v) => v.isValid);
    const avgConfidence = validVotes.reduce((sum, v) => sum + v.confidence, 0) / validVotes.length;

    // 严重性投票（加权）
    const severityVotes: Record<FindingSeverity, number> = {
      high: 0,
      medium: 0,
      low: 0,
    };

    validVotes.forEach((vote) => {
      severityVotes[vote.severity] += vote.confidence;
    });

    const agreedSeverity =
      (Object.entries(severityVotes).sort((a, b) => b[1] - a[1])[0][0] as FindingSeverity) ||
      finding.severity;

    // 综合推理
    const synthesizedDetail = `${finding.detail}\n\n**专家Debate意见汇总：**\n${validVotes
      .map(
        (v) => `- ${v.agentName} (${v.severity}, 置信度${v.confidence.toFixed(2)}): ${v.reasoning}`
      )
      .join('\n')}`;

    logger.info('Debate达成共识', {
      finding: finding.title,
      originalSeverity: finding.severity,
      agreedSeverity,
      originalConfidence: finding.confidence,
      avgConfidence,
      validVotes: validVotes.length,
    });

    return {
      ...finding,
      confidence: avgConfidence,
      severity: agreedSeverity,
      detail: synthesizedDetail,
    };
  }
}
