import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { kernelSessionRepository } from '../agent-kernel/session/session-repository';
import config from '../config';
import { kernelReviewEngine } from '../review/kernel/kernel-review-engine';
import { getReviewSessionScope } from '../review/kernel/session-scope';
import { LearningSystem } from '../review/learning/learning-system';
import { VectorMemoryStore } from '../review/memory/vector-store';
import { FileReviewStore } from '../review/store/file-review-store';
import { giteaService } from '../services/gitea';

const feedbackRouter = new Hono();

// 全局实例
let memoryStore: VectorMemoryStore | null = null;
let learningSystem: LearningSystem | null = null;
let reviewStore: FileReviewStore | null = null;

// 初始化反馈系统（记忆系统可选）
export function initializeFeedbackSystem(store: FileReviewStore): void {
  // 保存store实例以供handlers重用，避免多实例状态不同步
  reviewStore = store;

  // 记忆系统为可选功能
  if (config.review.qdrantUrl && config.review.enableMemory) {
    memoryStore = new VectorMemoryStore(config.review.qdrantUrl);
    learningSystem = new LearningSystem(memoryStore, reviewStore);

    memoryStore.initialize().catch((err) => {
      console.error('Failed to initialize memory store:', err);
    });
  }
}

// 提交人工反馈
feedbackRouter.post(
  '/finding/:findingId',
  zValidator(
    'json',
    z.object({
      approved: z.boolean().describe('是否批准该finding'),
      reason: z.string().optional().describe('反馈原因'),
      reviewer: z.string().optional().describe('审查者'),
    })
  ),
  async (c) => {
    const { findingId } = c.req.param();
    const { approved, reason } = c.req.valid('json');

    if (!reviewStore) {
      return c.json({ error: 'Feedback system not initialized' }, 503);
    }

    // 重用已初始化的store实例，避免多实例状态不同步
    const finding = await reviewStore.getFinding(findingId);

    if (!finding) {
      return c.json({ error: 'Finding not found' }, 404);
    }

    // 获取run信息以获取owner和repo
    const runDetails = await reviewStore.getRunDetails(finding.runId);
    if (!runDetails) {
      return c.json({ error: 'Run not found' }, 404);
    }

    const session = kernelSessionRepository.getSessionByScopeKey(
      getReviewSessionScope(runDetails.run).scopeKey
    );

    const { owner, repo } = runDetails.run;

    // 原子幂等性保护：先标记finding为published（原子check-and-set）
    // 只有第一个请求会得到true，后续并发/重试请求会得到false
    // 这解决了read-check-write竞态：两个并发请求不会都发布评论
    const wasUnpublished = await reviewStore.markFindingPublished(
      finding.runId,
      finding.fingerprint
    );

    if (!wasUnpublished) {
      // finding已被标记为published，但需验证是否真的发布成功
      // 场景：并发请求A正在发布时请求B到达，或请求A发布失败回滚后请求B重试
      // 检查是否存在已发布的comment记录来确认真实状态
      // 关键：必须通过fingerprint匹配，而非仅path+line，以区分同一位置的不同findings
      const publishedComment = runDetails.comments.find(
        (c) => c.status === 'published' && c.fingerprint === finding.fingerprint
      );

      if (publishedComment) {
        // 确认已成功发布到Gitea（存在published comment record），返回幂等成功
        return c.json({
          success: true,
          message: '该finding已处理过',
          alreadyProcessed: true,
          learningApplied: false,
          published: true,
        });
      }
      // published标记存在但无published comment记录
      // 可能原因：1) 并发请求正在发布中 2) 之前发布失败并回滚
      // 不能声称成功，返回错误让用户稍后重试
      return c.json(
        {
          error: 'Finding approval in progress or previously failed. Please retry in a moment.',
          inProgress: true,
        },
        409
      ); // 409 Conflict
    }

    // 以下代码只会被第一个请求执行（wasUnpublished=true）

    let learningApplied = false;

    // 如果记忆系统启用，尝试执行学习和向量存储（可选功能，失败不阻止审批流程）
    if (memoryStore && learningSystem) {
      try {
        await memoryStore.storeFeedback(findingId, approved, reason || '', owner, repo);

        if (approved) {
          await learningSystem.learnFromApproval(finding, owner, repo);
        } else {
          await learningSystem.learnFromFalsePositive(
            finding,
            reason || '人工标记为误报',
            owner,
            repo
          );
        }

        learningApplied = true;
      } catch (memoryError) {
        // 记忆系统故障不应阻止人工审批操作
        console.error('Memory system operation failed (non-fatal):', memoryError);
        learningApplied = false;
      }
    }

    try {
      // 如果批准，发布到Gitea（人工审批通过的问题应该通知开发者）
      if (approved) {
        const comment = `## 🔍 AI代码审查问题（人工确认）

**${finding.title}**

严重程度: ${finding.severity}
置信度: ${(finding.confidence * 100).toFixed(0)}%

${finding.detail}

${finding.evidence ? `**证据:**\n\`\`\`\n${finding.evidence}\n\`\`\`` : ''}

${finding.suggestion ? `**建议:**\n${finding.suggestion}` : ''}

---
_此问题已通过人工审批确认_`;

        // 关键：区分Gitea发布失败和本地store失败，避免重复发布
        // 1. 先发布到Gitea，失败则回滚published标记
        // 2. 再写本地record，失败不回滚（因为Gitea已成功，重试不应重复发布）
        try {
          if (runDetails.run.eventType === 'pull_request' && runDetails.run.prNumber) {
            await giteaService.addPullRequestComment(owner, repo, runDetails.run.prNumber, comment);
          } else if (runDetails.run.commitSha) {
            await giteaService.addCommitComment(owner, repo, runDetails.run.commitSha, comment);
          }
        } catch (giteaError) {
          // Gitea API失败：回滚published状态，允许用户重试发布
          await reviewStore.unmarkFindingPublished(finding.runId, finding.fingerprint);
          throw giteaError;
        }

        // Gitea发布成功，写入本地record
        // 关键权衡：如果record写入失败，必须回滚published标记以保持可恢复性
        // 代价：立即重试可能导致重复Gitea评论（罕见边缘情况，优于永久卡死）
        try {
          await reviewStore.addCommentRecord({
            runId: finding.runId,
            status: 'published',
            body: comment,
            path: finding.path,
            line: finding.line,
            fingerprint: finding.fingerprint,
          });
        } catch (storeError) {
          // 本地store失败：回滚published标记，允许用户重试
          // 如果用户立即重试，可能导致重复Gitea评论（可接受的权衡以避免永久卡死）
          console.error(
            'Failed to persist comment record after successful Gitea publish, rolling back:',
            storeError
          );
          await reviewStore.unmarkFindingPublished(finding.runId, finding.fingerprint);
          throw new Error(
            'Comment published to Gitea but failed to save locally. State rolled back, you may retry. Note: immediate retry may create duplicate comments.'
          );
        }
      } else {
        // 拒绝（标记为误报）：创建comment record以标记处理完成
        // 不发布到Gitea，但需要记录以使重试请求能识别已处理
        // 如果写入失败，回滚published标记以允许重试
        try {
          await reviewStore.addCommentRecord({
            runId: finding.runId,
            status: 'published',
            body: `REJECTED: ${finding.title} - ${reason || '人工标记为误报'}`,
            path: finding.path,
            line: finding.line,
            fingerprint: finding.fingerprint,
          });
        } catch (storeError) {
          // 拒绝record写入失败：回滚published标记，允许用户重试
          await reviewStore.unmarkFindingPublished(finding.runId, finding.fingerprint);
          throw storeError;
        }
      }

      // finding已在开头原子标记为published，处理成功则保持published状态
      if (session) {
        kernelSessionRepository.appendEvent(session.id, 'human_feedback_processed', {
          runId: finding.runId,
          findingId,
          approved,
          reason: reason || null,
          published: approved,
        });

        if (config.review.engine === 'kernel') {
          const latestRunDetails = await reviewStore.getRunDetails(finding.runId);
          const hasRemainingPendingFindings =
            latestRunDetails?.findings.some((item) => !item.published) ?? false;

          if (!hasRemainingPendingFindings) {
            await kernelReviewEngine.continueSession(session.id);
          }
        }
      }

      return c.json({
        success: true,
        message: approved ? '已标记为有效问题并发布到Gitea' : '已标记为误报',
        learningApplied,
        published: approved,
      });
    } catch (error) {
      console.error('Failed to process feedback:', error);
      return c.json(
        {
          error: 'Failed to process feedback',
          details: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  }
);

// 获取待审批的findings
feedbackRouter.get('/pending', async (c) => {
  if (!reviewStore) {
    return c.json({ error: 'Feedback system not initialized' }, 503);
  }

  const limit = Number(c.req.query('limit') || '50');

  try {
    const pendingFindings = await reviewStore.getPendingFindings(limit);

    return c.json({
      findings: pendingFindings,
      total: pendingFindings.length,
    });
  } catch (error) {
    console.error('Failed to fetch pending findings:', error);
    return c.json(
      {
        error: 'Failed to fetch pending findings',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

// 获取finding详情
feedbackRouter.get('/finding/:findingId', async (c) => {
  if (!reviewStore) {
    return c.json({ error: 'Feedback system not initialized' }, 503);
  }

  const { findingId } = c.req.param();

  try {
    const finding = await reviewStore.getFinding(findingId);

    if (!finding) {
      return c.json({ error: 'Finding not found' }, 404);
    }

    // 获取run详情以提供更多上下文
    const runDetails = await reviewStore.getRunDetails(finding.runId);

    return c.json({
      finding,
      run: runDetails?.run,
    });
  } catch (error) {
    console.error('Failed to fetch finding:', error);
    return c.json(
      {
        error: 'Failed to fetch finding',
        details: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

export { feedbackRouter };
