import { createHash } from 'node:crypto';
import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../utils/logger';
import { SandboxExec } from './sandbox-exec';

export interface LocalRepoPaths {
  mirrorPath: string;
  workspacePath: string;
}

function hashRepo(owner: string, repo: string): string {
  return createHash('sha256').update(`${owner}/${repo}`).digest('hex').slice(0, 16);
}

export class LocalRepoManager {
  private mirrorLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly workDir: string,
    private readonly sandboxExec: SandboxExec,
    private readonly commandTimeoutMs: number,
    private readonly giteaToken?: string
  ) {}

  /**
   * 构建git命令的认证配置参数（非持久化）
   * 使用http.extraHeader避免将token存储在git config中
   */
  private getAuthArgs(): string[] {
    if (!this.giteaToken) {
      return [];
    }
    // 使用Authorization header，不会持久化到.git/config
    return ['-c', `http.extraHeader=Authorization: token ${this.giteaToken}`];
  }

  /**
   * 获取mirror仓库的互斥锁，防止并发修改同一mirror
   * 返回一个unlock函数，调用者必须在完成后调用
   */
  private async acquireMirrorLock(mirrorPath: string): Promise<() => void> {
    // 获取前一个锁（如果有），用于排队等待
    const currentLock = this.mirrorLocks.get(mirrorPath) || Promise.resolve();

    let releaseLock: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // 将新锁存入map（供后续调用者排队）
    // 修复：直接存储newLock而非chain，使unlock时的比较能够正确工作
    this.mirrorLocks.set(mirrorPath, newLock);

    // 等待前一个锁完成
    await currentLock;

    // 返回解锁函数
    return () => {
      releaseLock!();
      // 如果map中还是当前锁（没有新的等待者），清理以避免内存泄漏
      if (this.mirrorLocks.get(mirrorPath) === newLock) {
        this.mirrorLocks.delete(mirrorPath);
      }
    };
  }

  async prepareWorkspace(
    owner: string,
    repo: string,
    cloneUrl: string,
    targetSha: string,
    runId: string,
    headCloneUrl?: string
  ): Promise<LocalRepoPaths> {
    const repoHash = hashRepo(owner, repo);
    const mirrorsRoot = path.join(this.workDir, 'repos');
    const workspacesRoot = path.join(this.workDir, 'workspaces');
    const mirrorPath = path.join(mirrorsRoot, `${repoHash}.git`);
    const workspacePath = path.join(workspacesRoot, runId);

    await mkdir(mirrorsRoot, { recursive: true });
    await mkdir(workspacesRoot, { recursive: true });

    // 获取mirror锁，防止并发修改同一mirror（remote set-url/fetch冲突）
    const unlock = await this.acquireMirrorLock(mirrorPath);

    try {
      const authArgs = this.getAuthArgs();
      const mirrorExists = await this.pathExists(mirrorPath);

      if (!mirrorExists) {
        logger.info('创建本地 mirror 仓库', { owner, repo, mirrorPath });
        await this.sandboxExec.run(
          'git',
          [...authArgs, 'clone', '--mirror', cloneUrl, mirrorPath],
          {
            cwd: this.workDir,
            timeoutMs: this.commandTimeoutMs,
          }
        );
      } else {
        // 更新remote URL（不含认证信息）
        await this.sandboxExec.run(
          'git',
          ['--git-dir', mirrorPath, 'remote', 'set-url', 'origin', cloneUrl],
          {
            cwd: this.workDir,
            timeoutMs: this.commandTimeoutMs,
          }
        );
        // fetch使用认证参数
        await this.sandboxExec.run(
          'git',
          [...authArgs, '--git-dir', mirrorPath, 'fetch', '--prune', 'origin', '+refs/*:refs/*', '^refs/reviewed/*'],
          {
            cwd: this.workDir,
            timeoutMs: this.commandTimeoutMs,
          }
        );
      }

      // Fork PR场景：添加head remote并fetch，确保head SHA可用
      if (headCloneUrl && headCloneUrl !== cloneUrl) {
        logger.info('Fork PR检测，添加head remote', { owner, repo, headCloneUrl });

        // 检查head remote是否已存在，存在则更新URL
        const remoteListResult = await this.sandboxExec.run(
          'git',
          ['--git-dir', mirrorPath, 'remote'],
          {
            cwd: this.workDir,
            timeoutMs: this.commandTimeoutMs,
          }
        );
        const hasHeadRemote = remoteListResult.stdout.includes('head');

        if (hasHeadRemote) {
          await this.sandboxExec.run(
            'git',
            ['--git-dir', mirrorPath, 'remote', 'set-url', 'head', headCloneUrl],
            {
              cwd: this.workDir,
              timeoutMs: this.commandTimeoutMs,
            }
          );
        } else {
          await this.sandboxExec.run(
            'git',
            ['--git-dir', mirrorPath, 'remote', 'add', 'head', headCloneUrl],
            {
              cwd: this.workDir,
              timeoutMs: this.commandTimeoutMs,
            }
          );
        }

        // Fetch head remote
        await this.sandboxExec.run(
          'git',
          [
            ...authArgs,
            '--git-dir',
            mirrorPath,
            'fetch',
            'head',
            '+refs/heads/*:refs/remotes/head/*',
          ],
          {
            cwd: this.workDir,
            timeoutMs: this.commandTimeoutMs,
          }
        );
      }

      await rm(workspacePath, { recursive: true, force: true });

      // 清理可能存在的stale worktree元数据（崩溃恢复时目录已删除但元数据仍注册）
      // prune会移除所有已删除但仍注册的worktree
      // 注意：prune/add也会修改mirror元数据，必须在锁保护下执行，防止并发冲突
      await this.sandboxExec.run('git', ['--git-dir', mirrorPath, 'worktree', 'prune'], {
        cwd: this.workDir,
        timeoutMs: this.commandTimeoutMs,
      });

      await this.sandboxExec.run(
        'git',
        ['--git-dir', mirrorPath, 'worktree', 'add', '--detach', workspacePath, targetSha],
        {
          cwd: this.workDir,
          timeoutMs: this.commandTimeoutMs,
        }
      );
    } finally {
      // 确保锁总是被释放，在所有mirror-mutating操作（fetch/prune/add）完成后释放
      unlock();
    }

    return {
      mirrorPath,
      workspacePath,
    };
  }

  async cleanupWorkspace(paths: LocalRepoPaths): Promise<void> {
    // worktree remove也会修改mirror元数据，需要使用mirror锁防止与prepareWorkspace并发冲突
    const unlock = await this.acquireMirrorLock(paths.mirrorPath);

    try {
      await this.sandboxExec.run(
        'git',
        ['--git-dir', paths.mirrorPath, 'worktree', 'remove', '--force', paths.workspacePath],
        {
          cwd: this.workDir,
          timeoutMs: this.commandTimeoutMs,
        }
      );
    } catch (error) {
      logger.warn('移除 git worktree 失败，尝试直接清理目录', {
        workspacePath: paths.workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
      await rm(paths.workspacePath, { recursive: true, force: true });
    } finally {
      // 确保锁总是被释放
      unlock();
    }
  }

  async resolveCommitParent(workspacePath: string, commitSha: string): Promise<string | null> {
    try {
      const result = await this.sandboxExec.run('git', ['rev-parse', `${commitSha}^`], {
        cwd: workspacePath,
        timeoutMs: this.commandTimeoutMs,
      });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 保存审查快照 ref，记录 PR 最后一次成功审查的 baseSha 和 headSha
   * 存储在 mirror 的 refs/reviewed/pr/{prNumber}/head 和 refs/reviewed/pr/{prNumber}/base
   */
  async saveReviewedRef(mirrorPath: string, prNumber: number, baseSha: string, headSha: string): Promise<void> {
    const unlock = await this.acquireMirrorLock(mirrorPath);
    try {
      const headRef = `refs/reviewed/pr/${prNumber}/head`;
      const baseRef = `refs/reviewed/pr/${prNumber}/base`;
      await this.sandboxExec.run(
        'git',
        ['--git-dir', mirrorPath, 'update-ref', headRef, headSha],
        {
          cwd: this.workDir,
          timeoutMs: this.commandTimeoutMs,
        }
      );
      await this.sandboxExec.run(
        'git',
        ['--git-dir', mirrorPath, 'update-ref', baseRef, baseSha],
        {
          cwd: this.workDir,
          timeoutMs: this.commandTimeoutMs,
        }
      );
      logger.info('已保存审查快照 ref', { mirrorPath, prNumber, baseSha, headSha });
    } finally {
      unlock();
    }
  }

  /**
   * 解析上次审查的快照（baseSha + headSha）
   * 如果任一 ref 不存在，返回 null
   */
  async resolveReviewedRef(mirrorPath: string, prNumber: number): Promise<{ baseSha: string; headSha: string } | null> {
    try {
      const headRef = `refs/reviewed/pr/${prNumber}/head`;
      const baseRef = `refs/reviewed/pr/${prNumber}/base`;
      const headResult = await this.sandboxExec.run(
        'git',
        ['--git-dir', mirrorPath, 'rev-parse', '--verify', headRef],
        {
          cwd: this.workDir,
          timeoutMs: this.commandTimeoutMs,
        }
      );
      const baseResult = await this.sandboxExec.run(
        'git',
        ['--git-dir', mirrorPath, 'rev-parse', '--verify', baseRef],
        {
          cwd: this.workDir,
          timeoutMs: this.commandTimeoutMs,
        }
      );
      const headSha = headResult.stdout.trim();
      const baseSha = baseResult.stdout.trim();
      if (!headSha || !baseSha) return null;
      return { baseSha, headSha };
    } catch {
      return null;
    }
  }

}
