import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabase, initDatabase } from '../../../db/database';
import { llmGateway } from '../../../llm/gateway';
import { giteaService } from '../../../services/gitea';
import { FileReviewStore } from '../../store/file-review-store';
import { kernelReviewEngine } from '../kernel-review-engine';

export interface KernelBoundaryRestorePoint {
  restore(): void;
}

export interface KernelTestFixture {
  tempDir: string;
  store: FileReviewStore;
  cleanup(): Promise<void>;
}

export async function createKernelTestFixture(prefix: string): Promise<KernelTestFixture> {
  const tempDir = await mkdtemp(path.join(tmpdir(), prefix));
  process.env.DATABASE_PATH = path.join(tempDir, 'assistant.db');
  initDatabase();

  const store = new FileReviewStore(path.join(tempDir, 'review-workdir'));
  await store.init();

  return {
    tempDir,
    store,
    cleanup: async () => {
      closeDatabase();
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

export function captureKernelBoundaryRestorePoint(): KernelBoundaryRestorePoint {
  const engine = kernelReviewEngine as any;
  const originalChatForRole = llmGateway.chatForRole;
  const originalAddPullRequestComment = giteaService.addPullRequestComment;
  const originalAddCommitComment = giteaService.addCommitComment;
  const originalAddLineComments = giteaService.addLineComments;
  const originalGetRelatedPullRequest = giteaService.getRelatedPullRequest;
  const originalEngineStart = engine.start;
  const originalEngineCreateRuntime = engine.createRuntime;
  const originalEngineStore = engine._store;

  return {
    restore() {
      llmGateway.chatForRole = originalChatForRole;
      giteaService.addPullRequestComment = originalAddPullRequestComment;
      giteaService.addCommitComment = originalAddCommitComment;
      giteaService.addLineComments = originalAddLineComments;
      giteaService.getRelatedPullRequest = originalGetRelatedPullRequest;
      engine.start = originalEngineStart;
      engine.createRuntime = originalEngineCreateRuntime;
      engine._store = originalEngineStore;
    },
  };
}
