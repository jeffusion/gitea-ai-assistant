import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRepoManager } from '../local-repo-manager';
import { SandboxExec } from '../sandbox-exec';

async function runGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed with code=${exitCode}: ${stderr}`);
  }

  return { stdout, stderr };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function createSeedCommits(
  rootDir: string,
  bareRepoPath: string,
  count: number
): Promise<string[]> {
  const seedRepoPath = path.join(rootDir, 'seed');
  await mkdir(seedRepoPath, { recursive: true });

  await runGit(['init'], seedRepoPath);
  await runGit(['config', 'user.name', 'Test User'], seedRepoPath);
  await runGit(['config', 'user.email', 'test@example.com'], seedRepoPath);

  const commitShas: string[] = [];
  for (let index = 0; index < count; index++) {
    const filePath = path.join(seedRepoPath, 'fixture.txt');
    await writeFile(filePath, `fixture-${index}\n`, 'utf8');
    await runGit(['add', 'fixture.txt'], seedRepoPath);
    await runGit(['commit', '-m', `commit-${index}`], seedRepoPath);

    const revParse = await runGit(['rev-parse', 'HEAD'], seedRepoPath);
    commitShas.push(revParse.stdout.trim());
  }

  await runGit(['remote', 'add', 'origin', bareRepoPath], seedRepoPath);
  await runGit(['push', 'origin', 'HEAD:refs/heads/main'], seedRepoPath);

  return commitShas;
}

describe('LocalRepoManager snapshot refs and cleanup', () => {
  let tempDir: string;
  let workDir: string;
  let mirrorPath: string;
  let sandbox: SandboxExec;
  let manager: LocalRepoManager;
  let commitShas: string[];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'local-repo-manager-test-'));
    workDir = path.join(tempDir, 'workdir');
    mirrorPath = path.join(tempDir, 'mirror.git');

    await mkdir(workDir, { recursive: true });

    await runGit(['init', '--bare', mirrorPath]);

    commitShas = await createSeedCommits(tempDir, mirrorPath, 8);

    sandbox = new SandboxExec(['git']);
    manager = new LocalRepoManager(workDir, sandbox, 10_000);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('saveReviewedRef / resolveReviewedRef', () => {
    test('saveReviewedRef stores base/head refs and resolveReviewedRef reads them back', async () => {
      const prNumber = 101;
      const baseSha = commitShas[5];
      const headSha = commitShas[7];

      await manager.saveReviewedRef(mirrorPath, prNumber, baseSha, headSha);

      const resolved = await manager.resolveReviewedRef(mirrorPath, prNumber);
      expect(resolved).toEqual({ baseSha, headSha });

      const headRef = await sandbox.run(
        'git',
        ['--git-dir', mirrorPath, 'rev-parse', '--verify', `refs/reviewed/pr/${prNumber}/head`],
        { cwd: workDir, timeoutMs: 10_000 }
      );
      const baseRef = await sandbox.run(
        'git',
        ['--git-dir', mirrorPath, 'rev-parse', '--verify', `refs/reviewed/pr/${prNumber}/base`],
        { cwd: workDir, timeoutMs: 10_000 }
      );

      expect(headRef.stdout.trim()).toBe(headSha);
      expect(baseRef.stdout.trim()).toBe(baseSha);
    });

    test('resolveReviewedRef returns null when refs do not exist', async () => {
      const resolved = await manager.resolveReviewedRef(mirrorPath, 9999);
      expect(resolved).toBeNull();
    });

    test('concurrent saveReviewedRef calls keep ref pair consistent', async () => {
      const prNumber = 202;
      const pairs = commitShas.slice(0, 7).map((baseSha, index) => ({
        baseSha,
        headSha: commitShas[index + 1],
      }));

      await Promise.all(
        pairs.map((pair) =>
          manager.saveReviewedRef(mirrorPath, prNumber, pair.baseSha, pair.headSha)
        )
      );

      const resolved = await manager.resolveReviewedRef(mirrorPath, prNumber);
      expect(resolved).not.toBeNull();

      const matchedPair = pairs.find(
        (pair) => pair.baseSha === resolved!.baseSha && pair.headSha === resolved!.headSha
      );
      expect(matchedPair).toBeDefined();
    });
  });

  describe('deleteReviewedRefs', () => {
    test('removes reviewed refs and delete is idempotent when refs are missing', async () => {
      const prNumber = 303;
      const baseSha = commitShas[3];
      const headSha = commitShas[4];

      await manager.saveReviewedRef(mirrorPath, prNumber, baseSha, headSha);
      expect(await manager.resolveReviewedRef(mirrorPath, prNumber)).toEqual({ baseSha, headSha });

      await manager.deleteReviewedRefs(mirrorPath, prNumber);
      await manager.deleteReviewedRefs(mirrorPath, prNumber);

      const resolved = await manager.resolveReviewedRef(mirrorPath, prNumber);
      expect(resolved).toBeNull();
    });

    test('does not throw when deleting refs that never existed', async () => {
      await manager.deleteReviewedRefs(mirrorPath, 4040);
    });
  });

  describe('getMirrorPath', () => {
    test('returns hash-based mirror path for owner/repo', () => {
      const owner = 'octocat';
      const repo = 'hello-world';

      const expectedHash = createHash('sha256')
        .update(`${owner}/${repo}`)
        .digest('hex')
        .slice(0, 16);
      const expectedPath = path.join(workDir, 'repos', `${expectedHash}.git`);

      expect(manager.getMirrorPath(owner, repo)).toBe(expectedPath);
    });
  });

  describe('cleanStaleMirrors', () => {
    test('cleans stale mirrors/workspaces and keeps recent ones', async () => {
      const reposRoot = path.join(workDir, 'repos');
      const workspacesRoot = path.join(workDir, 'workspaces');

      const staleMirror = path.join(reposRoot, 'stale.git');
      const recentMirror = path.join(reposRoot, 'recent.git');
      const staleWorkspace = path.join(workspacesRoot, 'stale-ws');
      const recentWorkspace = path.join(workspacesRoot, 'recent-ws');

      await mkdir(staleMirror, { recursive: true });
      await mkdir(recentMirror, { recursive: true });
      await mkdir(staleWorkspace, { recursive: true });
      await mkdir(recentWorkspace, { recursive: true });

      const now = Date.now();
      const staleDate = new Date(now - 40 * 24 * 60 * 60 * 1000);
      const recentDate = new Date(now - 2 * 24 * 60 * 60 * 1000);

      await utimes(staleMirror, staleDate, staleDate);
      await utimes(recentMirror, recentDate, recentDate);
      await utimes(staleWorkspace, staleDate, staleDate);
      await utimes(recentWorkspace, recentDate, recentDate);

      const cleaned = await manager.cleanStaleMirrors(30);
      expect(cleaned).toBe(2);

      expect(await pathExists(staleMirror)).toBe(false);
      expect(await pathExists(staleWorkspace)).toBe(false);
      expect(await pathExists(recentMirror)).toBe(true);
      expect(await pathExists(recentWorkspace)).toBe(true);
    });

    test('returns 0 when repos directory does not exist', async () => {
      const cleanWorkDir = path.join(tempDir, 'clean-workdir');
      await mkdir(cleanWorkDir, { recursive: true });
      const cleanManager = new LocalRepoManager(cleanWorkDir, sandbox, 10_000);

      const cleaned = await cleanManager.cleanStaleMirrors(30);
      expect(cleaned).toBe(0);
    });
  });
});
