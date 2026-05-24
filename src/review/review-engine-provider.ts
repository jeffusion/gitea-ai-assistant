import config from '../config';
import { codexEngine } from './codex/codex-engine';
import { kernelReviewEngine } from './kernel/kernel-review-engine';
import type { FileReviewStore } from './store/file-review-store';
import type { CommitReviewPayload, PullRequestReviewPayload, ReviewRun } from './types';

export interface ReviewEngineInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueuePullRequest(
    payload: PullRequestReviewPayload
  ): Promise<{ run: ReviewRun; reused: boolean }>;
  enqueueCommit(payload: CommitReviewPayload): Promise<{ run: ReviewRun; reused: boolean }>;
  listRuns(limit?: number): Promise<ReviewRun[]>;
  getRunDetails(runId: string): Promise<Awaited<ReturnType<FileReviewStore['getRunDetails']>>>;
  getStore(): FileReviewStore;
}

export function getActiveReviewEngine(): ReviewEngineInstance {
  if (config.review.engine === 'codex') {
    return codexEngine;
  }
  return kernelReviewEngine;
}

export function getReviewEngineLabel(): string {
  if (config.review.engine === 'codex') {
    return 'Codex';
  }
  return 'Kernel';
}
