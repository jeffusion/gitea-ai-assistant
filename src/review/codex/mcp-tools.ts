import { giteaService } from '../../services/gitea';
import { logger } from '../../utils/logger';
import type { FileReviewStore } from '../store/file-review-store';

/**
 * MCP 工具定义 — 描述 Codex 可以调用的工具
 */
export const MCP_TOOLS = [
  {
    name: 'get_pr_info',
    description:
      '获取当前 Pull Request 或 Commit 的元信息，包括 owner、repo、PR number、base SHA、head SHA 等。调用此工具了解审查目标的上下文。',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: 'add_review_summary',
    description:
      '发布代码审查总结评论到 Pull Request 或 Commit。在完成所有代码分析后调用此工具，提交你的总体审查结论。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description: '审查总结内容（Markdown 格式）',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'add_line_comment',
    description: '对代码的特定行添加审查评论。仅针对发现严重问题的代码行调用此工具。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: '文件路径（相对于仓库根目录）',
        },
        line: {
          type: 'number',
          description: '代码行号（新文件中的行号）',
        },
        comment: {
          type: 'string',
          description: '评论内容',
        },
      },
      required: ['path', 'line', 'comment'],
    },
  },
];

/**
 * 审查上下文 — 由 CodexRunner 创建，传递给 MCP handler
 */
export interface ReviewRunContext {
  runId: string;
  owner: string;
  repo: string;
  prNumber?: number;
  relatedPrNumber?: number;
  commitSha?: string;
  baseSha?: string;
  headSha?: string;
  lastReviewedHead?: string;
}

/**
 * MCP 工具执行器
 */
export class McpToolExecutor {
  /** 活跃的审查上下文，按 runId 索引 */
  private contexts = new Map<string, ReviewRunContext>();

  constructor(private readonly store?: FileReviewStore) {}

  registerContext(ctx: ReviewRunContext): void {
    this.contexts.set(ctx.runId, ctx);
    logger.debug('MCP 注册审查上下文', { runId: ctx.runId, owner: ctx.owner, repo: ctx.repo });
  }

  unregisterContext(runId: string): void {
    this.contexts.delete(runId);
    logger.debug('MCP 注销审查上下文', { runId });
  }

  getContext(runId: string): ReviewRunContext | undefined {
    return this.contexts.get(runId);
  }

  /**
   * 执行 MCP 工具调用
   */
  async callTool(
    runId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const ctx = this.contexts.get(runId);
    if (!ctx) {
      return {
        content: [{ type: 'text', text: `错误：找不到审查上下文 (runId=${runId})` }],
        isError: true,
      };
    }

    try {
      switch (toolName) {
        case 'get_pr_info':
          return this.handleGetPrInfo(ctx);
        case 'add_review_summary':
          return await this.handleAddReviewSummary(ctx, args as { summary: string });
        case 'add_line_comment':
          return await this.handleAddLineComment(
            ctx,
            args as { path: string; line: number; comment: string }
          );
        default:
          return {
            content: [{ type: 'text', text: `未知工具: ${toolName}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('MCP 工具调用失败', { runId, toolName, error: message });
      return {
        content: [{ type: 'text', text: `工具执行失败: ${message}` }],
        isError: true,
      };
    }
  }

  private handleGetPrInfo(ctx: ReviewRunContext) {
    const info: Record<string, unknown> = {
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      baseSha: ctx.baseSha,
      headSha: ctx.headSha,
      commitSha: ctx.commitSha || ctx.headSha,
    };
    if (ctx.lastReviewedHead) {
      info.lastReviewedHead = ctx.lastReviewedHead;
      info.reviewMode = 'incremental';
    } else {
      info.reviewMode = 'full';
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
    };
  }

  private async handleAddReviewSummary(ctx: ReviewRunContext, args: { summary: string }) {
    const body = `## AI \u4ee3\u7801\u5ba1\u67e5\u7ed3\u679c\n\n${args.summary}`;

    // \u4f18\u5148\u901a\u8fc7 PR \u53d1\u5e03\u8bc4\u8bba
    let prNumber = ctx.prNumber;

    // \u5982\u679c\u6ca1\u6709\u76f4\u63a5\u7684 prNumber\uff0c\u5c1d\u8bd5\u901a\u8fc7 relatedPrNumber \u6216 API \u67e5\u627e\u5173\u8054 PR
    if (!prNumber) {
      prNumber = ctx.relatedPrNumber;
      if (!prNumber && ctx.commitSha) {
        const related = await giteaService.getRelatedPullRequest(
          ctx.owner,
          ctx.repo,
          ctx.commitSha
        );
        prNumber = related?.number;
      }
    }

    if (prNumber) {
      await giteaService.addPullRequestComment(ctx.owner, ctx.repo, prNumber, body);
      logger.info('Codex MCP: \u5df2\u53d1\u5e03 PR \u5ba1\u67e5\u603b\u7ed3', {
        runId: ctx.runId,
        prNumber,
      });
    } else if (ctx.commitSha) {
      await giteaService.addCommitComment(ctx.owner, ctx.repo, ctx.commitSha, body);
      logger.info('Codex MCP: \u5df2\u53d1\u5e03 Commit \u5ba1\u67e5\u603b\u7ed3', {
        runId: ctx.runId,
        commitSha: ctx.commitSha,
      });
    } else {
      return {
        content: [
          {
            type: 'text',
            text: '\u65e0\u6cd5\u53d1\u5e03\uff1a\u7f3a\u5c11 PR number \u6216 commit SHA',
          },
        ],
        isError: true,
      };
    }

    // 记录到 store
    if (this.store) {
      try {
        await this.store.addCommentRecord({
          runId: ctx.runId,
          status: 'published',
          body,
        });
      } catch (storeError) {
        logger.warn('MCP: 持久化 summary comment record 失败（非致命）', {
          runId: ctx.runId,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        });
      }
    }

    return {
      content: [{ type: 'text', text: '审查总结已发布成功' }],
    };
  }

  private async handleAddLineComment(
    ctx: ReviewRunContext,
    args: { path: string; line: number; comment: string }
  ) {
    const commitId = ctx.headSha || ctx.commitSha;
    if (!commitId) {
      return {
        content: [{ type: 'text', text: '无法添加行评论：缺少 commit SHA' }],
        isError: true,
      };
    }

    let prNumber = ctx.prNumber || ctx.relatedPrNumber;
    if (!prNumber) {
      const related = await giteaService.getRelatedPullRequest(ctx.owner, ctx.repo, commitId);
      prNumber = related?.number;
    }

    if (!prNumber) {
      return {
        content: [{ type: 'text', text: '无法添加行评论：找不到关联的 Pull Request' }],
        isError: true,
      };
    }

    await giteaService.addLineComments(ctx.owner, ctx.repo, prNumber, commitId, [
      { path: args.path, line: args.line, comment: args.comment },
    ]);

    logger.info('Codex MCP: 已发布行评论', {
      runId: ctx.runId,
      path: args.path,
      line: args.line,
    });

    // 记录到 store
    if (this.store) {
      try {
        await this.store.addCommentRecord({
          runId: ctx.runId,
          status: 'published',
          path: args.path,
          line: args.line,
          body: args.comment,
        });
      } catch (storeError) {
        logger.warn('MCP: 持久化 line comment record 失败（非致命）', {
          runId: ctx.runId,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        });
      }
    }

    return {
      content: [{ type: 'text', text: `行评论已添加: ${args.path}:${args.line}` }],
    };
  }
}

/** 全局单例 */
export const mcpToolExecutor = new McpToolExecutor();
