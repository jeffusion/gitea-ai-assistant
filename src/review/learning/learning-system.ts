import type { LLMMessage } from '../../llm/types';
import config from '../../config';
import { logger } from '../../utils/logger';
import { VectorMemoryStore } from '../memory/vector-store';
import { FileReviewStore } from '../store/file-review-store';
import { Finding, FindingCategory } from '../types';

export class LearningSystem {
  constructor(
    private memoryStore: VectorMemoryStore,
    private store: FileReviewStore
  ) {}

  async learnFromFalsePositive(
    finding: Finding,
    reason: string,
    owner: string,
    repo: string
  ): Promise<void> {
    // 存储误报模式到向量记忆
    await this.memoryStore.storeMemory({
      id: `fp-${finding.id}`,
      type: 'pattern',
      content: `False Positive: ${finding.title}\nReason: ${reason}\nEvidence: ${finding.evidence}\nCategory: ${finding.category}`,
      metadata: {
        category: finding.category,
        approved: false,
        timestamp: new Date().toISOString(),
        owner,
        repo,
        project: `${owner}/${repo}`,
      },
    });

    // 查找相似的未发布findings，降低置信度
    const similarFindings = await this.findSimilarPendingFindings(finding);

    for (const similar of similarFindings) {
      if (!similar.published && similar.confidence > 0.5) {
        const newConfidence = Math.max(similar.confidence - 0.2, 0.3);
        await this.store.updateFindingConfidence(similar.id, newConfidence);

        logger.info('从误报中学习，降低相似finding置信度', {
          findingId: similar.id,
          oldConfidence: similar.confidence,
          newConfidence,
        });
      }
    }

    logger.info('从误报中学习完成', {
      findingId: finding.id,
      category: finding.category,
      updatedSimilar: similarFindings.length,
    });
  }

  async generateFewShotExamples(
    category: FindingCategory,
    owner?: string,
    repo?: string
  ): Promise<LLMMessage[]> {
    const targetCount = config.review.fewShotExamplesCount;

    // 提前检查：如果few-shot被禁用（targetCount=0），直接返回，避免无意义的向量查询
    if (targetCount === 0) {
      return [];
    }

    // 构建过滤条件
    const filter: any = {
      must: [{ key: 'category', match: { value: category } }],
    };

    // 如果指定了项目，优先使用该项目的示例
    if (owner && repo) {
      filter.must.push({ key: 'project', match: { value: `${owner}/${repo}` } });
    }

    // 使用category名称作为通用查询而非空字符串，避免无意义的embedding调用
    const categoryQuery = `${category} issues in code`;

    // 获取已批准的正样本
    const approvedFilter = {
      must: [...filter.must, { key: 'approved', match: { value: true } }],
    };
    const approved = await this.memoryStore.searchSimilar(categoryQuery, 10, approvedFilter);

    // 获取误报的负样本
    const rejectedFilter = {
      must: [...filter.must, { key: 'approved', match: { value: false } }],
    };
    const rejected = await this.memoryStore.searchSimilar(categoryQuery, 5, rejectedFilter);

    // 如果项目内示例不足，补充全局示例
    if (approved.length < targetCount) {
      const globalApproved = await this.memoryStore.searchSimilar(categoryQuery, 10, {
        must: [
          { key: 'category', match: { value: category } },
          { key: 'approved', match: { value: true } },
        ],
      });
      approved.push(
        ...globalApproved.filter((a) => !approved.find((e) => e.entry.id === a.entry.id))
      );
    }

    const examples: LLMMessage[] = [];

    const negativeCount = Math.floor(targetCount * 0.4);

    // 添加正样本示例
    for (const a of approved.slice(0, targetCount)) {
      examples.push({
        role: 'user',
        content: `审查这段代码变更，关注${category}相关问题：\n${a.entry.content}`,
      });
      examples.push({
        role: 'assistant',
        content: JSON.stringify({
          findings: [
            {
              title: a.entry.content.split('\n')[0].replace('False Positive: ', ''),
              category,
              severity: a.entry.metadata.severity || 'medium',
              valid: true,
            },
          ],
        }),
      });
    }

    // 添加负样本示例（误报）
    for (const r of rejected.slice(0, negativeCount)) {
      examples.push({
        role: 'user',
        content: `审查这段代码变更，关注${category}相关问题：\n${r.entry.content}`,
      });
      examples.push({
        role: 'assistant',
        content: JSON.stringify({
          findings: [],
          reason: '历史反馈表明这类情况不应报告为问题',
        }),
      });
    }

    logger.debug('生成Few-shot示例', {
      category,
      positiveExamples: approved.length,
      negativeExamples: rejected.length,
      totalMessages: examples.length,
    });

    return examples;
  }

  private async findSimilarPendingFindings(_finding: Finding): Promise<Finding[]> {
    // 这里简化实现，实际应该查询数据库中相似的findings
    // 由于FileReviewStore没有这个方法，我们暂时返回空数组
    // 在实际部署时需要扩展FileReviewStore
    return [];
  }

  async learnFromApproval(finding: Finding, _owner: string, _repo: string): Promise<void> {
    // 将已批准的finding存储为正样本
    await this.memoryStore.storeFinding(finding, true, _owner, _repo);

    logger.info('从批准中学习完成', {
      findingId: finding.id,
      category: finding.category,
      severity: finding.severity,
    });
  }

  async getConfidenceAdjustment(
    finding: Omit<Finding, 'id' | 'runId' | 'published'>,
    owner: string,
    repo: string
  ): Promise<number> {
    // 搜索相似的误报（优先同一项目）
    const query = `${finding.title}\n${finding.evidence}`;
    const similarFalsePositives = await this.memoryStore.searchSimilar(query, 3, {
      must: [
        { key: 'type', match: { value: 'pattern' } },
        { key: 'category', match: { value: finding.category } },
        { key: 'project', match: { value: `${owner}/${repo}` } },
      ],
    });

    if (similarFalsePositives.length === 0) {
      return 0; // 无需调整
    }

    // 根据相似度计算置信度惩罚
    const maxSimilarity = Math.max(...similarFalsePositives.map((fp) => fp.score));

    if (maxSimilarity > 0.9) {
      return -0.3; // 高度相似的误报，大幅降低置信度
    }
    if (maxSimilarity > 0.8) {
      return -0.15; // 中度相似，适度降低
    }
    if (maxSimilarity > 0.7) {
      return -0.05; // 低度相似，略微降低
    }

    return 0;
  }
}
