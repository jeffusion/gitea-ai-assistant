import config from '../config';
import { logger } from '../utils/logger';
import { DiffExtractor } from './context/diff-extractor';
import { LocalRepoManager } from './context/local-repo-manager';
import { SandboxExec } from './context/sandbox-exec';
import { ReviewOrchestrator } from './orchestrator';
import { FileReviewStore } from './store/file-review-store';
import { CommitReviewPayload, PullRequestReviewPayload, ReviewRun } from './types';

class ReviewEngine {
  private readonly store = new FileReviewStore(config.review.workdir);
  private readonly sandboxExec = new SandboxExec(config.review.allowedCommands);
  private readonly localRepoManager = new LocalRepoManager(
    config.review.workdir,
    this.sandboxExec,
    config.review.commandTimeoutMs,
    config.gitea.accessToken
  );
  private readonly diffExtractor = new DiffExtractor(
    this.sandboxExec,
    this.localRepoManager,
    config.review.commandTimeoutMs,
    config.review.maxFilesPerRun,
    config.review.maxFileContentChars
  );
  private readonly orchestrator = new ReviewOrchestrator(
    this.store,
    this.localRepoManager,
    this.diffExtractor
  );

  private started = false;
  private activeRunsCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;

  async start(): Promise<void> {
    if (this.started || config.review.engine !== 'agent') {
      return;
    }

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
    logger.info('Agent Review Engine 已启动');
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
    // 防止重入：如果上一次tick还在执行，跳过本次调度
    if (this.tickInProgress) {
      return;
    }

    this.tickInProgress = true;
    try {
      // 检查是否达到并行限制
      const maxParallel = config.review.maxParallelRuns;
      if (this.activeRunsCount >= maxParallel) {
        return;
      }

      // 尝试获取并启动新任务，直到达到并行上限
      while (this.activeRunsCount < maxParallel) {
        const run = await this.store.acquireNextQueuedRun();
        if (!run) {
          break; // 队列为空
        }

        // 启动异步任务，不等待完成
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

    try {
      await this.orchestrator.execute(run);

      // 检查run状态，防止将ignored状态覆盖为succeeded
      const runDetails = await this.store.getRunDetails(run.id);
      if (runDetails && runDetails.run.status !== 'ignored') {
        await this.store.markRunSucceeded(run.id);
      }
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
}

export const reviewEngine = new ReviewEngine();
