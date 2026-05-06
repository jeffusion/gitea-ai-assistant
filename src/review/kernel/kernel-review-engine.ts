import { kernelSessionRepository } from '../../agent-kernel/session/session-repository';
import type { KernelTaskDefinition } from '../../agent-kernel/types';
import config from '../../config';
import { logger } from '../../utils/logger';
import { DiffExtractor } from '../context/diff-extractor';
import { LocalRepoManager } from '../context/local-repo-manager';
import { SandboxExec } from '../context/sandbox-exec';
import { FileReviewStore } from '../store/file-review-store';
import type { CommitReviewPayload, PullRequestReviewPayload, ReviewRun } from '../types';
import { ReviewKernelRuntime } from './review-kernel-runtime';
import { getReviewSessionScope } from './session-scope';

class KernelReviewEngine {
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

  private createRuntime(): ReviewKernelRuntime {
    const sandboxExec = this.createSandboxExec();
    const localRepoManager = this.createLocalRepoManager(sandboxExec);
    const diffExtractor = this.createDiffExtractor(sandboxExec, localRepoManager);
    return new ReviewKernelRuntime(this.store, localRepoManager, diffExtractor);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.store.init();
    const recovered = await this.store.recoverInterruptedRuns();
    if (recovered > 0) {
      logger.warn('Kernel Review Engine: 检测到未完成的审查任务，已重新入队', { recovered });
    }

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        logger.error('Kernel Review Engine tick 失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 1000);

    this.started = true;
    logger.info('Kernel Review Engine 已启动');
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
    const created = await this.store.createOrReuseRun(payload);
    this.ensureSessionForRun(created.run, created.run.id);
    return created;
  }

  async enqueueCommit(payload: CommitReviewPayload): Promise<{ run: ReviewRun; reused: boolean }> {
    await this.start();
    const created = await this.store.createOrReuseRun(payload);
    this.ensureSessionForRun(created.run, created.run.id);
    return created;
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

  listTaskCatalog(): KernelTaskDefinition[] {
    return this.createRuntime().listTaskCatalog();
  }

  listSubagentCatalog() {
    return this.createRuntime().listSubagentCatalog();
  }

  listHookCatalog() {
    return this.createRuntime().listHookCatalog();
  }

  async continueSession(sessionId: string): Promise<boolean> {
    await this.start();

    const session = kernelSessionRepository.getSessionById(sessionId);
    if (!session?.lastRunId) {
      return false;
    }

    const runDetails = await this.store.getRunDetails(session.lastRunId);
    if (!runDetails) {
      return false;
    }

    kernelSessionRepository.appendEvent(sessionId, 'session_continue_requested', {
      runId: runDetails.run.id,
    });

    const runtime = this.createRuntime();
    await runtime.continueExecution(runDetails.run, sessionId);

    kernelSessionRepository.appendEvent(sessionId, 'session_continue_completed', {
      runId: runDetails.run.id,
    });

    return true;
  }

  private ensureSessionForRun(run: ReviewRun, runId: string): string {
    const { scopeType, scopeKey } = getReviewSessionScope(run);
    const session = kernelSessionRepository.ensureSession({
      scopeType,
      scopeKey,
      metadata: {
        owner: run.owner,
        repo: run.repo,
        prNumber: run.prNumber ?? run.relatedPrNumber,
        eventType: run.eventType,
        headSha: run.headSha ?? run.commitSha,
      },
      runId,
    });
    kernelSessionRepository.appendEvent(session.id, 'review_enqueued', {
      runId,
      eventType: run.eventType,
      status: run.status,
      prNumber: run.prNumber ?? run.relatedPrNumber,
      commitSha: run.commitSha,
    });
    return session.id;
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
    logger.info('开始处理 Kernel 审查任务', {
      runId: run.id,
      owner: run.owner,
      repo: run.repo,
      eventType: run.eventType,
      activeRuns: this.activeRunsCount,
    });

    const runtime = this.createRuntime();
    const sessionId = this.ensureSessionForRun(run, run.id);

    try {
      await runtime.execute(run, sessionId);

      const runDetails = await this.store.getRunDetails(run.id);
      if (runDetails && runDetails.run.status !== 'ignored') {
        await this.store.markRunSucceeded(run.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      kernelSessionRepository.appendEvent(sessionId, 'run_failed', {
        runId: run.id,
        error: message,
      });

      const failed = await this.store.markRunFailed(run.id, message);
      if (!failed.requeued) {
        logger.error('Kernel 审查任务失败并达到重试上限', { runId: run.id, error: message });
      } else {
        logger.warn('Kernel 审查任务失败，已重新入队重试', { runId: run.id, error: message });
      }
    }
  }
}

export const kernelReviewEngine = new KernelReviewEngine();
