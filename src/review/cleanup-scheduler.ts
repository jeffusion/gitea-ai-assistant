import config from '../config';
import { logger } from '../utils/logger';
import { LocalRepoManager } from './context/local-repo-manager';
import { SandboxExec } from './context/sandbox-exec';

/** 过期 mirror 最大保留天数 */
const STALE_MIRROR_MAX_AGE_DAYS = 3;

/**
 * 清理调度器：每天凌晨 2:00 清理过期的 mirror 和残留 workspace 目录
 */
class CleanupScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    // 启动后延迟 60s 执行一次（避免启动高峰冲突）
    this.timer = setTimeout(() => {
      this.runCleanup();
      // 之后按每天凌晨 2:00 调度
      this.scheduleNextRun();
    }, 60_000);

    logger.info('清理调度器已启动', { maxAgeDays: STALE_MIRROR_MAX_AGE_DAYS });
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  private scheduleNextRun(): void {
    const now = new Date();
    const next = new Date(now);
    next.setHours(2, 0, 0, 0); // 凌晨 2:00
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1); // 已过今天 2:00，推到明天
    }
    const delayMs = next.getTime() - now.getTime();

    this.timer = setTimeout(() => {
      this.runCleanup();
      this.scheduleNextRun();
    }, delayMs);

    logger.debug('下次清理时间', { nextRun: next.toISOString(), delayMs });
  }

  private async runCleanup(): Promise<void> {
    logger.info('开始执行定时清理任务');
    try {
      const sandboxExec = new SandboxExec(config.review.allowedCommands);
      const localRepoManager = new LocalRepoManager(
        config.review.workdir,
        sandboxExec,
        config.review.commandTimeoutMs,
        config.gitea.accessToken
      );

      const cleaned = await localRepoManager.cleanStaleMirrors(STALE_MIRROR_MAX_AGE_DAYS);
      logger.info('定时清理任务完成', { cleanedDirectories: cleaned });
    } catch (error) {
      logger.error('定时清理任务失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const cleanupScheduler = new CleanupScheduler();
