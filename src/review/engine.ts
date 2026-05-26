import config from '../config';
import { providerRepo } from '../db/repositories/provider-repo';
import { llmGateway } from '../llm/gateway';
import { RuntimeE2EMockLLM } from '../llm/runtime-e2e-mock';
import { ReviewAgentEntrypoint } from '../review-agent';
import { giteaService } from '../services/gitea';
import { logger } from '../utils/logger';
import { DiffExtractor } from './context/diff-extractor';
import { LocalRepoManager } from './context/local-repo-manager';
import { SandboxExec } from './context/sandbox-exec';
import { tokenCounter } from './context/token-counter';
import { FileReviewStore } from './store/file-review-store';
import { CommitReviewPayload, PullRequestReviewPayload, ReviewRun } from './types';

export class ReviewEngine {
  // Sub-objects are created lazily per config snapshot.
  // store holds state (runs, steps) so we keep ONE instance but update workdir.
  private _store: FileReviewStore | null = null;
  private started = false;
  private activeRunsCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;

  /** Lazily-created store — stable singleton (holds review state). */
  private get store(): FileReviewStore {
    if (!this._store) {
      this._store = new FileReviewStore(config.review.workdir);
    }
    return this._store;
  }

  /** Fresh SandboxExec that always reflects current allowed-commands config. */
  private createSandboxExec(): SandboxExec {
    return new SandboxExec(config.review.allowedCommands);
  }

  /** Fresh LocalRepoManager that reads current config values. */
  private createLocalRepoManager(sandboxExec: SandboxExec): LocalRepoManager {
    return new LocalRepoManager(
      config.review.workdir,
      sandboxExec,
      config.review.commandTimeoutMs,
      config.gitea.accessToken
    );
  }

  /** Fresh DiffExtractor that reads current config values. */
  private createDiffExtractor(
    sandboxExec: SandboxExec,
    localRepoManager: LocalRepoManager
  ): DiffExtractor {
    return new DiffExtractor(
      sandboxExec,
      localRepoManager,
      config.review.commandTimeoutMs,
      config.review.maxFilesPerRun,
      config.review.maxFileContentChars
    );
  }

  private createReviewAgentEntrypoint(): ReviewAgentEntrypoint {
    const sandboxExec = this.createSandboxExec();
    const localRepoManager = this.createLocalRepoManager(sandboxExec);
    const diffExtractor = this.createDiffExtractor(sandboxExec, localRepoManager);
    const useE2EMock = process.env.E2E_MOCK_LLM === '1';
    return new ReviewAgentEntrypoint({
      store: this.store,
      localRepoManager,
      diffExtractor,
      modelClient: useE2EMock
        ? new RuntimeE2EMockLLM()
        : {
            chat: async (request) => {
              const provider = providerRepo.list(true)[0];
              if (!provider)
                throw new Error('No enabled LLM provider configured for review main agent');
              return llmGateway.chatDirect(provider.id, request);
            },
          },
    });
  }

  async start(): Promise<void> {
    if (this.started || config.review.engine !== 'agent') {
      return;
    }

    // Configure LLM Gateway resilience from current config
    llmGateway.updateResilienceConfig(config.review.llmMaxConcurrentCalls, {
      maxAttempts: config.review.llmRetryMaxAttempts,
      baseDelayMs: config.review.llmRetryBaseDelayMs,
    });

    // Preload dynamic model catalog from models.dev (non-blocking)
    tokenCounter.refreshCatalog().catch((error) => {
      logger.warn('Model catalog preload failed, using static data', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    await this.store.init();
    const recovered = await this.store.recoverInterruptedRuns();
    if (recovered > 0) {
      logger.warn('检测到未完成的审查任务，已重新入队', { recovered });
    }

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        logger.error('Review Engine tick 失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 1000);

    this.started = true;
    logger.info('Agent Review Engine 已启动', {
      llmMaxConcurrent: config.review.llmMaxConcurrentCalls,
      llmRetryMaxAttempts: config.review.llmRetryMaxAttempts,
    });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    tokenCounter.stopRefresh();
    this.started = false;
  }

  async enqueuePullRequest(
    payload: PullRequestReviewPayload
  ): Promise<{ run: ReviewRun; reused: boolean }> {
    await this.store.init();
    return this.store.createOrReuseRun(payload);
  }

  async enqueueCommit(payload: CommitReviewPayload): Promise<{ run: ReviewRun; reused: boolean }> {
    await this.store.init();
    return this.store.createOrReuseRun(payload);
  }

  async listRuns(limit = 50): Promise<ReviewRun[]> {
    return this.store.listRuns(limit);
  }

  async getRunDetails(
    runId: string
  ): Promise<Awaited<ReturnType<FileReviewStore['getRunDetails']>>> {
    return this.store.getRunDetails(runId);
  }

  getStore(): FileReviewStore {
    return this.store;
  }

  private async tick(): Promise<void> {
    if (this.tickInProgress) {
      return;
    }

    this.tickInProgress = true;
    try {
      const maxParallel = config.review.maxParallelRuns;
      if (this.activeRunsCount >= maxParallel) {
        return;
      }

      while (this.activeRunsCount < maxParallel) {
        const run = await this.store.acquireNextQueuedRun();
        if (!run) {
          break;
        }

        this.activeRunsCount++;
        this.processRun(run).finally(() => {
          this.activeRunsCount--;
        });
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  private async processRun(run: ReviewRun): Promise<void> {
    logger.info('开始处理 Agent 审查任务', {
      runId: run.id,
      owner: run.owner,
      repo: run.repo,
      eventType: run.eventType,
      activeRuns: this.activeRunsCount,
    });

    const entrypoint = this.createReviewAgentEntrypoint();

    try {
      await entrypoint.execute(run);

      const runDetails = await this.store.getRunDetails(run.id);
      if (runDetails && runDetails.run.status !== 'ignored') {
        await this.store.markRunSucceeded(run.id);
      }

      await this.publishPendingComments(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.store.markRunFailed(run.id, message);
      if (!failed.requeued) {
        logger.error('审查任务失败并达到重试上限', { runId: run.id, error: message });
      } else {
        logger.warn('审查任务失败，已重新入队重试', { runId: run.id, error: message });
      }
    }
  }

  /**
   * 发布 pending 评论到 Gitea：
   * - 无 path/line → PR issue comment（summary）
   * - 有 path/line → PR review line comment（行级）
   */
  private async publishPendingComments(run: ReviewRun): Promise<void> {
    if (!run.prNumber) {
      const pending = await this.store.getPendingComments(run.id);
      if (pending.length > 0 && run.commitSha) {
        for (const comment of pending) {
          try {
            await giteaService.addCommitComment(run.owner, run.repo, run.commitSha, comment.body);
            await this.store.markCommentPublished(comment.id);
          } catch (error) {
            logger.error('发布 commit 评论失败', {
              runId: run.id,
              commentId: comment.id,
              error: error instanceof Error ? error.message : String(error),
            });
            await this.store.markCommentFailed(comment.id);
          }
        }
      }
      return;
    }

    const pending = await this.store.getPendingComments(run.id);
    if (pending.length === 0) return;

    const summaryComments = pending.filter((c) => !c.path);
    const lineComments = pending.filter((c) => c.path);

    for (const comment of summaryComments) {
      try {
        await giteaService.addPullRequestComment(run.owner, run.repo, run.prNumber, comment.body);
        await this.store.markCommentPublished(comment.id);
        logger.info('已发布 PR summary 评论', { runId: run.id, commentId: comment.id });
      } catch (error) {
        logger.error('发布 PR summary 评论失败', {
          runId: run.id,
          commentId: comment.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.store.markCommentFailed(comment.id);
      }
    }

    if (lineComments.length > 0 && run.headSha) {
      try {
        const lineCommentPayload = lineComments.map((c) => ({
          path: c.path!,
          line: c.line ?? 1,
          comment: c.body,
        }));
        await giteaService.addLineComments(
          run.owner,
          run.repo,
          run.prNumber,
          run.headSha,
          lineCommentPayload
        );
        for (const comment of lineComments) {
          await this.store.markCommentPublished(comment.id);
        }
        logger.info('已发布 PR 行级评论', {
          runId: run.id,
          count: lineComments.length,
        });
      } catch (error) {
        logger.error('发布 PR 行级评论失败', {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
        for (const comment of lineComments) {
          await this.store.markCommentFailed(comment.id);
        }
      }
    }

    for (const comment of pending) {
      if (comment.fingerprint) {
        await this.store.markFindingPublished(run.id, comment.fingerprint);
      }
    }
  }
}

export const reviewEngine = new ReviewEngine();
