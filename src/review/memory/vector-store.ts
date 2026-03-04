import { QdrantClient } from '@qdrant/js-client-rest';
import { llmGateway } from '../../llm/gateway';
import { logger } from '../../utils/logger';
import { Finding } from '../types';
import { MemoryEntry, MemorySearchResult } from './types';

export class VectorMemoryStore {
  private client: QdrantClient;
  private collectionName = 'code_review_memory';
  private initialized = false;

  constructor(qdrantUrl: string) {
    this.client = new QdrantClient({ url: qdrantUrl });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some((c) => c.name === this.collectionName);

      if (!exists) {
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: 1536, // text-embedding-3-small dimension
            distance: 'Cosine',
          },
        });
        logger.info('向量记忆集合已创建', { collection: this.collectionName });
      }

      this.initialized = true;
      logger.info('向量记忆系统已初始化');
    } catch (error) {
      logger.error('向量记忆系统初始化失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async storeMemory(entry: MemoryEntry): Promise<void> {
    await this.initialize();

    const [embedding] = await this.getEmbedding([entry.content]);

    await this.client.upsert(this.collectionName, {
      points: [
        {
          id: entry.id,
          vector: embedding,
          payload: {
            type: entry.type,
            content: entry.content,
            ...entry.metadata,
          },
        },
      ],
    });

    logger.debug('记忆已存储', {
      id: entry.id,
      type: entry.type,
      category: entry.metadata.category,
    });
  }

  async searchSimilar(query: string, limit = 5, filter?: any): Promise<MemorySearchResult[]> {
    await this.initialize();

    const [queryEmbedding] = await this.getEmbedding([query]);

    const results = await this.client.search(this.collectionName, {
      vector: queryEmbedding,
      limit,
      filter,
    });

    return results.map((r) => ({
      entry: {
        id: String(r.id),
        type: r.payload?.type as any,
        content: r.payload?.content as string,
        metadata: {
          category: r.payload?.category as string,
          severity: r.payload?.severity as string,
          approved: r.payload?.approved as boolean,
          timestamp: r.payload?.timestamp as string,
          project: r.payload?.project as string,
          owner: r.payload?.owner as string,
          repo: r.payload?.repo as string,
        },
      },
      score: r.score,
      distance: 1 - r.score,
    }));
  }

  private async getEmbedding(texts: string[]): Promise<number[][]> {
    try {
      return llmGateway.embedForRole(texts.map((text) => text.slice(0, 8000))); // 限制长度防止超出token限制
    } catch (error) {
      logger.error('生成embedding失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async storeFinding(
    finding: Finding,
    approved: boolean,
    owner: string,
    repo: string
  ): Promise<void> {
    const content = `${finding.title}\n${finding.detail}\nEvidence: ${finding.evidence}`;

    // 使用repo-scoped ID防止不同仓库的findings相互覆盖
    const scopedId = `${owner}/${repo}:${finding.fingerprint}`;

    await this.storeMemory({
      id: scopedId,
      type: 'finding',
      content,
      metadata: {
        category: finding.category,
        severity: finding.severity,
        approved,
        timestamp: new Date().toISOString(),
        owner,
        repo,
        project: `${owner}/${repo}`,
      },
    });
  }

  async getHistoricalContext(
    currentFinding: Partial<Finding>,
    owner: string,
    repo: string
  ): Promise<string> {
    const query = `${currentFinding.title}\n${currentFinding.evidence || ''}`;

    // 优先搜索同一项目的相似问题
    const projectSimilar = await this.searchSimilar(query, 2, {
      must: [
        { key: 'approved', match: { value: true } },
        { key: 'project', match: { value: `${owner}/${repo}` } },
      ],
    });

    // 如果项目内没有足够相似问题，搜索全局
    let similar = projectSimilar;
    if (similar.length < 2) {
      const globalSimilar = await this.searchSimilar(query, 3, {
        must: [{ key: 'approved', match: { value: true } }],
      });
      similar = [...projectSimilar, ...globalSimilar].slice(0, 3);
    }

    if (similar.length === 0) {
      return '';
    }

    return `\n\n历史相似问题参考：\n${similar
      .map(
        (s, i) =>
          `${i + 1}. ${s.entry.content.split('\n')[0]} (相似度: ${(s.score * 100).toFixed(1)}%, 项目: ${
            s.entry.metadata.project || '未知'
          })`
      )
      .join('\n')}`;
  }

  async storeFeedback(
    findingId: string,
    approved: boolean,
    reason: string,
    owner: string,
    repo: string
  ): Promise<void> {
    const content = `Feedback: ${approved ? 'Approved' : 'Rejected'}\nReason: ${reason}\nFinding ID: ${findingId}`;

    await this.storeMemory({
      id: `feedback-${findingId}-${Date.now()}`,
      type: 'feedback',
      content,
      metadata: {
        approved,
        timestamp: new Date().toISOString(),
        owner,
        repo,
        project: `${owner}/${repo}`,
      },
    });
  }
}
