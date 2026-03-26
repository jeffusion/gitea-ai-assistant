import { repositoryReviewPromptRepo } from '../db/repositories/repository-review-prompt-repo';
import { logger } from '../utils/logger';

export function resolveProjectReviewPrompt(owner: string, repo: string): string | undefined {
  try {
    return repositoryReviewPromptRepo.getProjectPrompt(owner, repo);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Database not initialized')) {
      return undefined;
    }

    logger.warn('读取项目级审查提示词失败，回退为仅全局提示词', {
      owner,
      repo,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
