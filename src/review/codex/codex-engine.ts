import config from '../../config';
import { logger } from '../../utils/logger';
import { LocalRepoManager } from '../context/local-repo-manager';
import { SandboxExec } from '../context/sandbox-exec';
import { FileReviewStore } from '../store/file-review-store';
import type { CommitReviewPayload, PullRequestReviewPayload, ReviewRun } from '../types';
import { CodexRunner } from './codex-runner';

/**
 * Codex 审查引擎
 *
 * 与 agent ReviewEngine 类似的队列调度引擎，但使用 Codex CLI 执行审查。
 * 复用 FileReviewStore 进行状态管理、LocalRepoManager 进行仓库准备。
 */
class CodexEngine {
  private _store: FileReviewStore | null = null;
  private started = false;
  private activeRunsCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;

  private get store(): FileReviewStore {
    if (!this._store) {
      this._store = new FileReviewStore(config.review.workdir);
    }
    return this._store;
  }

  private createSandboxExec(): SandboxExec {
    return new SandboxExec(config.review.allowedCommands);
  }

  private createLocalRepoManager(sandboxExec: SandboxExec): LocalRepoManager {
    return new LocalRepoManager(
      config.review.workdir,
      sandboxExec,
      config.review.commandTimeoutMs,
      config.gitea.accessToken
    );
  }

  private createRunner(): CodexRunner {
    const sandboxExec = this.createSandboxExec();
    const localRepoManager = this.createLocalRepoManager(sandboxExec);
    return new CodexRunner(this.store, localRepoManager);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }


    await this.store.init();
    const recovered = await this.store.recoverInterruptedRuns();
    if (recovered > 0) {
      logger.warn('Codex Engine: 检测到未完成的审查任务，已重新入队', { recovered });
    }

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        logger.error('Codex Engine tick 失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 1000);

    this.started = true;
    logger.info('Codex Review Engine 已启动', {
      model: config.review.codexModel,
      apiUrl: config.review.codexApiUrl,
    });
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
    await this.start();
    return this.store.createOrReuseRun(payload);
  }

  async enqueueCommit(payload: CommitReviewPayload): Promise<{ run: ReviewRun; reused: boolean }> {
    await this.start();
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
    logger.info('开始处理 Codex 审查任务', {
      runId: run.id,
      owner: run.owner,
      repo: run.repo,
      eventType: run.eventType,
      activeRuns: this.activeRunsCount,
    });

    const runner = this.createRunner();

    try {
      await runner.execute(run);

      const runDetails = await this.store.getRunDetails(run.id);
      if (runDetails && runDetails.run.status !== 'ignored') {
        await this.store.markRunSucceeded(run.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.store.markRunFailed(run.id, message);
      if (!failed.requeued) {
        logger.error('Codex 审查任务失败并达到重试上限', { runId: run.id, error: message });
      } else {
        logger.warn('Codex 审查任务失败，已重新入队重试', { runId: run.id, error: message });
      }
    }
  }
}

export const codexEngine = new CodexEngine();
