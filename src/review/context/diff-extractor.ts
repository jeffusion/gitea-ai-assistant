import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../utils/logger';
import { ChangedFile, DiffFile, ReviewContext, ReviewRun } from '../types';
import { LocalRepoManager } from './local-repo-manager';
import { SandboxExec } from './sandbox-exec';
import { tokenCounter } from './token-counter';

function toStatus(status: string): ChangedFile['status'] {
  const value = status.trim().charAt(0).toUpperCase();
  if (['A', 'M', 'D', 'R', 'C', 'T', 'U', 'X', 'B'].includes(value)) {
    return value as ChangedFile['status'];
  }
  return 'M';
}

function safePath(basePath: string, relativePath: string): string {
  const resolved = path.resolve(basePath, relativePath);
  if (!resolved.startsWith(path.resolve(basePath))) {
    throw new Error(`非法文件路径: ${relativePath}`);
  }
  return resolved;
}

export class DiffExtractor {
  constructor(
    private readonly sandboxExec: SandboxExec,
    private readonly localRepoManager: LocalRepoManager,
    private readonly commandTimeoutMs: number,
    private readonly maxFilesPerRun: number,
    private readonly maxFileContentChars: number
  ) {}

  getSandbox(): SandboxExec {
    return this.sandboxExec;
  }

  async buildContext(
    run: ReviewRun,
    mirrorPath: string,
    workspacePath: string,
    lastReviewedHead?: string
  ): Promise<ReviewContext> {
    const targetSha = run.headSha || run.commitSha;
    if (!targetSha) {
      throw new Error('缺少 target sha，无法构建审查上下文');
    }

    let baseSha = run.baseSha;
    // 增量审查：如果提供了 lastReviewedHead，用它替换 baseSha
    const incremental = !!lastReviewedHead;
    if (lastReviewedHead) {
      baseSha = lastReviewedHead;
    }
    if (!baseSha) {
      baseSha =
        (await this.localRepoManager.resolveCommitParent(workspacePath, targetSha)) || undefined;
    }

    // Root commit场景：没有parent，使用git show获取完整diff
    const isRootCommit = !baseSha;
    const diff = isRootCommit
      ? await this.getRootCommitDiff(workspacePath, targetSha)
      : await this.getDiff(workspacePath, run.eventType, baseSha!, targetSha, incremental);

    const changedFiles = isRootCommit
      ? await this.getRootCommitChangedFiles(workspacePath, targetSha)
      : await this.getChangedFiles(workspacePath, baseSha!, targetSha, incremental);

    // 构建允许的文件路径集合，确保parsedDiff也受REVIEW_MAX_FILES_PER_RUN限制
    const allowedPaths = new Set(changedFiles.map((f) => f.path));
    const parsedDiff = this.parseDiff(diff, allowedPaths);

    const fileContents = await this.readChangedFileContents(workspacePath, changedFiles);

    // Token-budget guard: clip raw diff to 30k tokens to prevent context overflow
    // This is the raw diff that gets passed around; toCompactContext() does further reduction
    const MAX_RAW_DIFF_TOKENS = 30_000;
    let clippedDiff = diff;
    const diffTokens = tokenCounter.count(diff);
    if (diffTokens > MAX_RAW_DIFF_TOKENS) {
      logger.warn('Raw diff exceeds token budget, clipping', {
        estimatedTokens: diffTokens,
        limit: MAX_RAW_DIFF_TOKENS,
      });
      clippedDiff = tokenCounter.clip(diff, MAX_RAW_DIFF_TOKENS);
    }

    return {
      workspacePath,
      mirrorPath,
      diff: clippedDiff,
      changedFiles,
      parsedDiff,
      fileContents,
    };
  }

  private async getRootCommitDiff(workspacePath: string, sha: string): Promise<string> {
    // Root commit：使用git show获取完整diff（相当于与空树的diff）
    const response = await this.sandboxExec.run('git', ['show', '--format=', '--unified=3', sha], {
      cwd: workspacePath,
      timeoutMs: this.commandTimeoutMs,
    });
    return response.stdout;
  }

  private async getDiff(
    workspacePath: string,
    eventType: ReviewRun['eventType'],
    baseSha: string,
    targetSha: string,
    incremental = false
  ): Promise<string> {
    if (eventType === 'pull_request') {
      const response = await this.sandboxExec.run(
        'git',
        ['diff', '--unified=3', `${baseSha}${incremental ? '..' : '...'}${targetSha}`],
        {
          cwd: workspacePath,
          timeoutMs: this.commandTimeoutMs,
        }
      );
      return response.stdout;
    }

    const response = await this.sandboxExec.run(
      'git',
      ['show', '--format=', '--unified=3', targetSha],
      {
        cwd: workspacePath,
        timeoutMs: this.commandTimeoutMs,
      }
    );
    return response.stdout;
  }

  private async getRootCommitChangedFiles(
    workspacePath: string,
    sha: string
  ): Promise<ChangedFile[]> {
    // Root commit：所有文件都是新增的（A状态）
    // --root flag是必需的，否则diff-tree对root commit返回空输出
    const statusResult = await this.sandboxExec.run(
      'git',
      ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', sha],
      {
        cwd: workspacePath,
        timeoutMs: this.commandTimeoutMs,
      }
    );

    const numStatResult = await this.sandboxExec.run(
      'git',
      ['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', sha],
      {
        cwd: workspacePath,
        timeoutMs: this.commandTimeoutMs,
      }
    );

    const numMap = new Map<string, { additions: number; deletions: number }>();
    for (const line of numStatResult.stdout.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const [addRaw = '0', delRaw = '0', filename] = line.split('\t');
      if (!filename) {
        continue;
      }
      const additions = Number.parseInt(addRaw, 10);
      const deletions = Number.parseInt(delRaw, 10);
      numMap.set(filename, {
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
      });
    }

    const changedFiles: ChangedFile[] = [];
    for (const line of statusResult.stdout.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const [statusRaw = 'A', ...pathParts] = line.split('\t');
      const filePath = pathParts[pathParts.length - 1];
      if (!filePath) {
        continue;
      }
      const stats = numMap.get(filePath) || { additions: 0, deletions: 0 };
      changedFiles.push({
        path: filePath,
        status: toStatus(statusRaw),
        additions: stats.additions,
        deletions: stats.deletions,
      });
      if (changedFiles.length >= this.maxFilesPerRun) {
        break;
      }
    }

    return changedFiles;
  }

  private async getChangedFiles(
    workspacePath: string,
    baseSha: string,
    targetSha: string,
    incremental = false
  ): Promise<ChangedFile[]> {
    const statusResult = await this.sandboxExec.run(
      'git',
      ['diff', '--name-status', `${baseSha}${incremental ? '..' : '...'}${targetSha}`],
      {
        cwd: workspacePath,
        timeoutMs: this.commandTimeoutMs,
      }
    );

    const numStatResult = await this.sandboxExec.run(
      'git',
      ['diff', '--numstat', `${baseSha}${incremental ? '..' : '...'}${targetSha}`],
      {
        cwd: workspacePath,
        timeoutMs: this.commandTimeoutMs,
      }
    );

    const numMap = new Map<string, { additions: number; deletions: number }>();
    for (const line of numStatResult.stdout.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const [addRaw = '0', delRaw = '0', filename] = line.split('\t');
      if (!filename) {
        continue;
      }
      const additions = Number.parseInt(addRaw, 10);
      const deletions = Number.parseInt(delRaw, 10);
      numMap.set(filename, {
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
      });
    }

    const changedFiles: ChangedFile[] = [];
    for (const line of statusResult.stdout.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const [statusRaw = 'M', ...pathParts] = line.split('\t');
      const filePath = pathParts[pathParts.length - 1];
      if (!filePath) {
        continue;
      }
      const stats = numMap.get(filePath) || { additions: 0, deletions: 0 };
      changedFiles.push({
        path: filePath,
        status: toStatus(statusRaw),
        additions: stats.additions,
        deletions: stats.deletions,
      });
      if (changedFiles.length >= this.maxFilesPerRun) {
        break;
      }
    }

    return changedFiles;
  }

  private async readChangedFileContents(
    workspacePath: string,
    changedFiles: ChangedFile[]
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    for (const file of changedFiles) {
      if (file.status === 'D') {
        continue;
      }
      try {
        const filePath = safePath(workspacePath, file.path);

        // 安全检查：拒绝符号链接以防止主机文件泄露
        const stats = await lstat(filePath);
        if (stats.isSymbolicLink()) {
          continue;
        }

        const content = await readFile(filePath, 'utf-8');
        result[file.path] = content.slice(0, this.maxFileContentChars);
      } catch (error) {
        logger.debug('读取变更文件失败，已跳过', {
          path: file.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  parseDiff(diffContent: string, allowedPaths?: Set<string>): DiffFile[] {
    const files: DiffFile[] = [];
    const lines = diffContent.split('\n');

    let currentFile: DiffFile | null = null;
    let oldLineNumber = 0;
    let newLineNumber = 0;
    let inHunk = false;
    let skipCurrentFile = false;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        if (currentFile && !skipCurrentFile) {
          files.push(currentFile);
        }
        currentFile = { path: '', changes: [] };
        inHunk = false;
        skipCurrentFile = false;
        continue;
      }

      if (!currentFile) {
        continue;
      }

      if (line.startsWith('+++ b/')) {
        currentFile.path = line.substring(6);
        // 如果提供了allowedPaths，检查当前文件是否在允许列表中
        if (allowedPaths && !allowedPaths.has(currentFile.path)) {
          skipCurrentFile = true;
        }
        continue;
      }

      // 如果跳过当前文件，忽略所有后续内容直到下一个文件
      if (skipCurrentFile) {
        continue;
      }

      if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match?.[1] && match[2]) {
          oldLineNumber = Number.parseInt(match[1], 10) - 1;
          newLineNumber = Number.parseInt(match[2], 10) - 1;
          inHunk = true;
        }
        continue;
      }

      if (!inHunk) {
        continue;
      }

      if (line.startsWith('+')) {
        newLineNumber += 1;
        currentFile.changes.push({
          lineNumber: newLineNumber,
          oldLineNumber,
          content: line.slice(1),
          type: 'add',
        });
      } else if (line.startsWith(' ')) {
        oldLineNumber += 1;
        newLineNumber += 1;
        currentFile.changes.push({
          lineNumber: newLineNumber,
          oldLineNumber,
          content: line.slice(1),
          type: 'context',
        });
      } else if (line.startsWith('-')) {
        oldLineNumber += 1;
        currentFile.changes.push({
          lineNumber: Math.max(1, newLineNumber + 1),
          oldLineNumber,
          content: line.slice(1),
          type: 'delete',
        });
      }
    }

    if (currentFile && !skipCurrentFile) {
      files.push(currentFile);
    }

    return files.filter((file) => file.path && file.changes.length > 0);
  }
}
