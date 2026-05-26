import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CommitReviewPayload,
  Finding,
  PullRequestReviewPayload,
  ReviewCommentRecord,
  ReviewPayload,
  ReviewRun,
  ReviewRunStatus,
  ReviewStep,
} from '../types';

interface ReviewStoreData {
  runs: ReviewRun[];
  steps: ReviewStep[];
  findings: Finding[];
  comments: ReviewCommentRecord[];
}

function nowIso(): string {
  return new Date().toISOString();
}

// 创建全新的空数据结构，避免共享引用
function createEmptyData(): ReviewStoreData {
  return {
    runs: [],
    steps: [],
    findings: [],
    comments: [],
  };
}

export class FileReviewStore {
  private readonly statePath: string;
  private data: ReviewStoreData = createEmptyData();
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();
  private initPromise: Promise<void> | null = null;

  constructor(workDir: string) {
    this.statePath = path.join(workDir, 'state', 'review-store.json');
  }

  async init(): Promise<void> {
    // 如果已初始化，直接返回
    if (this.initialized) {
      return;
    }

    // 如果有正在进行的init，等待它完成（防止并发init导致数据竞争）
    if (this.initPromise) {
      return this.initPromise;
    }

    // 创建initPromise来序列化并发init调用
    this.initPromise = (async () => {
      try {
        await mkdir(path.dirname(this.statePath), { recursive: true });

        try {
          const raw = await readFile(this.statePath, 'utf-8');
          const parsed = JSON.parse(raw) as ReviewStoreData;
          this.data = {
            runs: parsed.runs ?? [],
            steps: parsed.steps ?? [],
            findings: parsed.findings ?? [],
            comments: parsed.comments ?? [],
          };
        } catch (error: any) {
          // 仅在文件不存在（初始化）时创建空数据
          // 读取/解析错误时抛出异常，避免擦除现有数据
          if (error.code === 'ENOENT') {
            this.data = createEmptyData();
            await this.persist();
          } else {
            throw new Error(`Store初始化失败 - 拒绝擦除数据: ${error.message || String(error)}`);
          }
        }

        this.initialized = true;
      } finally {
        // 无论成功或失败，清理initPromise以允许失败后重试
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  async createOrReuseRun(payload: ReviewPayload): Promise<{ run: ReviewRun; reused: boolean }> {
    await this.ensureInitialized();

    const existing = this.data.runs.find(
      (run) => run.idempotencyKey === payload.idempotencyKey && run.status !== 'failed'
    );

    if (existing) {
      return { run: existing, reused: true };
    }

    // 防止同一 idempotencyKey 的 failed runs 无限累积：
    // 如果已存在超过 MAX_FAILED_RUNS_PER_KEY 个失败记录，清理最早的记录
    const MAX_FAILED_RUNS_PER_KEY = 3;
    const failedRuns = this.data.runs.filter(
      (run) => run.idempotencyKey === payload.idempotencyKey && run.status === 'failed'
    );
    if (failedRuns.length >= MAX_FAILED_RUNS_PER_KEY) {
      // 按创建时间升序排列，移除最早的记录
      failedRuns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const toRemove = failedRuns.slice(0, failedRuns.length - MAX_FAILED_RUNS_PER_KEY + 1);
      const removeIds = new Set(toRemove.map((r) => r.id));
      this.data.runs = this.data.runs.filter((run) => !removeIds.has(run.id));
      // 同时清理关联的 steps、findings、comments
      this.data.steps = this.data.steps.filter((s) => !removeIds.has(s.runId));
      this.data.findings = this.data.findings.filter((f) => !removeIds.has(f.runId));
      this.data.comments = this.data.comments.filter((c) => !removeIds.has(c.runId));
    }

    const timestamp = nowIso();
    const baseRun: ReviewRun = {
      id: randomUUID(),
      idempotencyKey: payload.idempotencyKey,
      eventType: payload.eventType,
      status: 'queued',
      owner: payload.owner,
      repo: payload.repo,
      cloneUrl: payload.cloneUrl,
      headCloneUrl: payload.headCloneUrl,
      attempts: 0,
      maxAttempts: payload.maxAttempts ?? 2,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const run = this.populateRunDetails(baseRun, payload);
    this.data.runs.push(run);
    await this.persist();

    return { run, reused: false };
  }

  async recoverInterruptedRuns(): Promise<number> {
    await this.ensureInitialized();

    let recovered = 0;
    const timestamp = nowIso();
    for (const run of this.data.runs) {
      if (run.status === 'in_progress') {
        run.status = 'queued';
        run.updatedAt = timestamp;
        recovered += 1;
      }
    }

    if (recovered > 0) {
      await this.persist();
    }

    return recovered;
  }

  async acquireNextQueuedRun(): Promise<ReviewRun | null> {
    await this.ensureInitialized();

    const run = this.data.runs.find((item) => item.status === 'queued');
    if (!run) {
      return null;
    }

    run.status = 'in_progress';
    run.startedAt = nowIso();
    run.updatedAt = run.startedAt;
    await this.persist();

    return { ...run };
  }

  async markRunSucceeded(runId: string): Promise<void> {
    await this.markRunFinished(runId, 'succeeded');
  }

  async markRunIgnored(runId: string, reason: string): Promise<void> {
    await this.markRunFinished(runId, 'ignored', reason);
  }

  async markRunFailed(
    runId: string,
    error: string
  ): Promise<{ requeued: boolean; run: ReviewRun | null }> {
    await this.ensureInitialized();

    const run = this.data.runs.find((item) => item.id === runId);
    if (!run) {
      return { requeued: false, run: null };
    }

    run.attempts += 1;
    run.error = error;
    run.updatedAt = nowIso();

    const shouldRetry = run.attempts < run.maxAttempts;
    if (shouldRetry) {
      run.status = 'queued';
      run.startedAt = undefined;
    } else {
      run.status = 'failed';
      run.finishedAt = nowIso();
    }

    await this.persist();
    return { requeued: shouldRetry, run: { ...run } };
  }

  async addStep(step: Omit<ReviewStep, 'id'>): Promise<ReviewStep> {
    await this.ensureInitialized();

    const record: ReviewStep = {
      ...step,
      id: randomUUID(),
    };

    this.data.steps.push(record);
    await this.persist();

    return record;
  }

  async addFindings(runId: string, findings: Finding[]): Promise<void> {
    await this.ensureInitialized();

    this.data.findings = this.data.findings.filter((item) => item.runId !== runId);
    this.data.findings.push(...findings);
    await this.persist();
  }

  async markFindingPublished(runId: string, fingerprint: string): Promise<boolean> {
    await this.ensureInitialized();

    let wasUnpublished = false;

    for (const finding of this.data.findings) {
      if (finding.runId === runId && finding.fingerprint === fingerprint) {
        // 返回true仅当finding从unpublished变为published（原子check-and-set）
        // 用于实现幂等性：只有第一个调用者会得到true
        if (!finding.published) {
          wasUnpublished = true;
          finding.published = true;
        }
      }
    }

    await this.persist();
    return wasUnpublished;
  }

  async unmarkFindingPublished(runId: string, fingerprint: string): Promise<void> {
    await this.ensureInitialized();

    for (const finding of this.data.findings) {
      if (finding.runId === runId && finding.fingerprint === fingerprint) {
        finding.published = false;
      }
    }

    await this.persist();
  }

  async addCommentRecord(comment: Omit<ReviewCommentRecord, 'id' | 'createdAt'>): Promise<void> {
    await this.ensureInitialized();

    const record: ReviewCommentRecord = {
      ...comment,
      id: randomUUID(),
      createdAt: nowIso(),
    };

    this.data.comments.push(record);
    await this.persist();
  }

  async getPendingComments(runId: string): Promise<ReviewCommentRecord[]> {
    await this.ensureInitialized();
    return this.data.comments.filter((c) => c.runId === runId && c.status === 'pending');
  }

  async markCommentPublished(commentId: string, giteaCommentId?: number): Promise<void> {
    await this.ensureInitialized();
    const comment = this.data.comments.find((c) => c.id === commentId);
    if (comment) {
      comment.status = 'published';
      if (giteaCommentId !== undefined) {
        comment.giteaCommentId = giteaCommentId;
      }
      await this.persist();
    }
  }

  async markCommentFailed(commentId: string): Promise<void> {
    await this.ensureInitialized();
    const comment = this.data.comments.find((c) => c.id === commentId);
    if (comment) {
      comment.status = 'failed';
      await this.persist();
    }
  }

  async listRuns(limit = 50): Promise<ReviewRun[]> {
    await this.ensureInitialized();

    const runs = [...this.data.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return runs.slice(0, limit);
  }

  async getRunDetails(runId: string): Promise<{
    run: ReviewRun;
    steps: ReviewStep[];
    findings: Finding[];
    comments: ReviewCommentRecord[];
  } | null> {
    await this.ensureInitialized();

    const run = this.data.runs.find((item) => item.id === runId);
    if (!run) {
      return null;
    }

    return {
      run: { ...run },
      steps: this.data.steps.filter((item) => item.runId === runId),
      findings: this.data.findings.filter((item) => item.runId === runId),
      comments: this.data.comments.filter((item) => item.runId === runId),
    };
  }

  async getFinding(findingId: string): Promise<Finding | null> {
    await this.ensureInitialized();

    const finding = this.data.findings.find((item) => item.id === findingId);
    return finding ? { ...finding } : null;
  }

  async updateFindingConfidence(findingId: string, newConfidence: number): Promise<void> {
    await this.ensureInitialized();

    const finding = this.data.findings.find((item) => item.id === findingId);
    if (finding) {
      finding.confidence = newConfidence;
      await this.persist();
    }
  }

  async getPendingFindings(limit = 100): Promise<Finding[]> {
    await this.ensureInitialized();

    return this.data.findings
      .filter((finding) => !finding.published)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
  }

  private populateRunDetails(baseRun: ReviewRun, payload: ReviewPayload): ReviewRun {
    if (payload.eventType === 'pull_request') {
      return this.populatePullRequestRun(baseRun, payload);
    }
    return this.populateCommitRun(baseRun, payload);
  }

  private populatePullRequestRun(baseRun: ReviewRun, payload: PullRequestReviewPayload): ReviewRun {
    return {
      ...baseRun,
      prNumber: payload.prNumber,
      baseSha: payload.baseSha,
      headSha: payload.headSha,
      commitSha: payload.headSha,
    };
  }

  private populateCommitRun(baseRun: ReviewRun, payload: CommitReviewPayload): ReviewRun {
    return {
      ...baseRun,
      commitSha: payload.commitSha,
      commitMessage: payload.commitMessage,
      relatedPrNumber: payload.relatedPrNumber,
      headSha: payload.commitSha,
    };
  }

  private async markRunFinished(
    runId: string,
    status: ReviewRunStatus,
    error?: string
  ): Promise<void> {
    await this.ensureInitialized();

    const run = this.data.runs.find((item) => item.id === runId);
    if (!run) {
      return;
    }

    run.status = status;
    run.error = error;
    run.finishedAt = nowIso();
    run.updatedAt = run.finishedAt;

    await this.persist();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  private async persist(): Promise<void> {
    // 追踪当前write操作是否成功，失败时立即抛出给调用者（防止静默数据丢失）
    let currentWriteError: Error | null = null;

    this.writeChain = this.writeChain.then(async () => {
      try {
        // 确保目标目录存在（/tmp 可能在容器重启后被清理）
        await mkdir(path.dirname(this.statePath), { recursive: true });
        // 原子写入：先写临时文件，再 rename 覆盖目标文件
        // POSIX rename 是原子操作，即使进程在 rename 中间崩溃，文件也不会损坏
        const tempPath = `${this.statePath}.tmp`;
        await writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf-8');
        await rename(tempPath, this.statePath);
        currentWriteError = null; // 写入成功
      } catch (error) {
        // 捕获错误但不重新throw，保持chain为resolved状态（允许后续persist()重试）
        currentWriteError = error instanceof Error ? error : new Error(String(error));
        console.error('Store persist failed:', currentWriteError);
      }
    });

    await this.writeChain;

    // 检查当前write是否失败，如果失败则立即向调用者报告
    // 这确保触发persist()的操作（如enqueueing run）不会返回成功而实际未持久化
    if (currentWriteError) {
      throw currentWriteError;
    }
  }
}
