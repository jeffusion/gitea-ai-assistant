import config from '../config';
import { logger } from '../utils/logger';
import { DiffExtractor } from './context/diff-extractor';
import { LocalRepoManager } from './context/local-repo-manager';
import { SandboxExec } from './context/sandbox-exec';
import { ReviewOrchestrator } from './orchestrator';
import { FileReviewStore } from './store/file-review-store';
import { CommitReviewPayload, PullRequestReviewPayload, ReviewRun } from './types';

class ReviewEngine {
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
  private createDiffExtractor(sandboxExec: SandboxExec, localRepoManager: LocalRepoManager): DiffExtractor {
    return new DiffExtractor(
      sandboxExec,
      localRepoManager,
      config.review.commandTimeoutMs,
      config.review.maxFilesPerRun,
      config.review.maxFileContentChars
    );
  }

  /** Create a fresh orchestrator with current config for each run. */
  private createOrchestrator(): ReviewOrchestrator {
    const sandboxExec = this.createSandboxExec();
    const localRepoManager = this.createLocalRepoManager(sandboxExec);
    const diffExtractor = this.createDiffExtractor(sandboxExec, localRepoManager);
    return new ReviewOrchestrator(this.store, localRepoManager, diffExtractor);
  }

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

    // Create a fresh orchestrator per run so it picks up latest config values
    const orchestrator = this.createOrchestrator();

    try {
      await orchestrator.execute(run);

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
