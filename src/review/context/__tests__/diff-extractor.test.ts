import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ReviewRun } from '../../types';
import { DiffExtractor } from '../diff-extractor';
import { LocalRepoManager } from '../local-repo-manager';
import { SandboxExec } from '../sandbox-exec';
import { tokenCounter } from '../token-counter';

interface DivergedFixture {
  tempDir: string;
  repoPath: string;
  extractor: DiffExtractor;
  run: ReviewRun;
  lastReviewedHead: string;
}

interface LargeDiffFixture {
  tempDir: string;
  repoPath: string;
  extractor: DiffExtractor;
  run: ReviewRun;
  unclippedDiff: string;
}

type GetDiffMethod = (
  workspacePath: string,
  eventType: ReviewRun['eventType'],
  baseSha: string,
  targetSha: string,
  incremental?: boolean
) => Promise<string>;

type GetChangedFilesMethod = (
  workspacePath: string,
  baseSha: string,
  targetSha: string,
  incremental?: boolean
) => Promise<Array<{ path: string }>>;

function createRun(baseSha: string, headSha: string, cloneUrl: string): ReviewRun {
  const now = new Date().toISOString();
  return {
    id: 'test-run-1',
    idempotencyKey: 'test',
    eventType: 'pull_request',
    status: 'in_progress',
    owner: 'test',
    repo: 'test',
    cloneUrl,
    baseSha,
    headSha,
    attempts: 1,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
  };
}

function createExtractor(workDir: string, sandbox: SandboxExec): DiffExtractor {
  const localRepoManager = new LocalRepoManager(workDir, sandbox, 10_000);
  return new DiffExtractor(sandbox, localRepoManager, 10_000, 200, 200_000);
}

async function setupDivergedRepoFixture(): Promise<DivergedFixture> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'diff-extractor-diverged-'));
  const repoPath = path.join(tempDir, 'repo');
  await mkdir(repoPath, { recursive: true });

  const sandbox = new SandboxExec(['git']);
  const git = async (...args: string[]) =>
    sandbox.run('git', args, {
      cwd: repoPath,
      timeoutMs: 10_000,
    });

  await git('init');
  await git('checkout', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test User');

  await writeFile(path.join(repoPath, 'shared.txt'), 'base-line\n', 'utf-8');
  await git('add', '.');
  await git('commit', '-m', 'base commit');

  await git('checkout', '-b', 'feature');
  await writeFile(path.join(repoPath, 'shared.txt'), 'base-line\nfeature-one-line\n', 'utf-8');
  await writeFile(path.join(repoPath, 'feature-only.txt'), 'feature branch commit one\n', 'utf-8');
  await git('add', '.');
  await git('commit', '-m', 'feature commit one');
  const lastReviewedHead = (await git('rev-parse', 'HEAD')).stdout.trim();

  await writeFile(
    path.join(repoPath, 'shared.txt'),
    'base-line\nfeature-one-line\nfeature-two-line\n',
    'utf-8'
  );
  await writeFile(
    path.join(repoPath, 'incremental-only.txt'),
    'feature branch commit two\n',
    'utf-8'
  );
  await git('add', '.');
  await git('commit', '-m', 'feature commit two');
  const headSha = (await git('rev-parse', 'HEAD')).stdout.trim();

  await git('checkout', 'main');
  await writeFile(path.join(repoPath, 'main-only.txt'), 'main branch only change\n', 'utf-8');
  await git('add', '.');
  await git('commit', '-m', 'main branch diverges');
  const baseSha = (await git('rev-parse', 'HEAD')).stdout.trim();

  await git('checkout', 'feature');

  const run = createRun(baseSha, headSha, `file://${repoPath}`);
  const extractor = createExtractor(tempDir, sandbox);

  return {
    tempDir,
    repoPath,
    extractor,
    run,
    lastReviewedHead,
  };
}

async function setupLargeDiffRepoFixture(): Promise<LargeDiffFixture> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'diff-extractor-large-diff-'));
  const repoPath = path.join(tempDir, 'repo');
  await mkdir(repoPath, { recursive: true });

  const sandbox = new SandboxExec(['git']);
  const git = async (...args: string[]) =>
    sandbox.run('git', args, {
      cwd: repoPath,
      timeoutMs: 10_000,
    });

  await git('init');
  await git('checkout', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test User');

  await writeFile(path.join(repoPath, 'huge.txt'), 'seed\n', 'utf-8');
  await git('add', '.');
  await git('commit', '-m', 'base commit');
  const baseSha = (await git('rev-parse', 'HEAD')).stdout.trim();

  const largePayload = `${'x'.repeat(140_000)}\n`;
  await writeFile(path.join(repoPath, 'huge.txt'), largePayload, 'utf-8');
  await git('add', '.');
  await git('commit', '-m', 'huge diff commit');
  const headSha = (await git('rev-parse', 'HEAD')).stdout.trim();

  const unclippedDiff = (await git('diff', '--unified=3', `${baseSha}...${headSha}`)).stdout;
  const run = createRun(baseSha, headSha, `file://${repoPath}`);
  const extractor = createExtractor(tempDir, sandbox);

  return {
    tempDir,
    repoPath,
    extractor,
    run,
    unclippedDiff,
  };
}

describe('DiffExtractor incremental review mode', () => {
  let fixture: DivergedFixture;

  beforeEach(async () => {
    fixture = await setupDivergedRepoFixture();
  });

  afterEach(async () => {
    await rm(fixture.tempDir, { recursive: true, force: true });
  });

  test('buildContext without lastReviewedHead uses base...head semantics', async () => {
    const context = await fixture.extractor.buildContext(
      fixture.run,
      fixture.repoPath,
      fixture.repoPath
    );

    const paths = context.changedFiles.map((file) => file.path);
    expect(paths).toContain('feature-only.txt');
    expect(paths).toContain('incremental-only.txt');
    expect(paths).toContain('shared.txt');
    expect(paths).not.toContain('main-only.txt');

    expect(context.diff).toContain('feature branch commit one');
    expect(context.diff).toContain('feature branch commit two');
    expect(context.diff).not.toContain('main branch only change');
  });

  test('buildContext with lastReviewedHead uses incremental two-dot range', async () => {
    const context = await fixture.extractor.buildContext(
      fixture.run,
      fixture.repoPath,
      fixture.repoPath,
      fixture.lastReviewedHead
    );

    const paths = context.changedFiles.map((file) => file.path);
    expect(paths).toContain('incremental-only.txt');
    expect(paths).toContain('shared.txt');
    expect(paths).not.toContain('feature-only.txt');
    expect(paths).not.toContain('main-only.txt');

    expect(context.diff).toContain('feature branch commit two');
    expect(context.diff).toContain('feature-two-line');
    expect(context.diff).not.toContain('feature branch commit one');
  });

  test('getDiff for pull_request incremental=false uses three-dot range', async () => {
    const getDiff = Reflect.get(fixture.extractor, 'getDiff').bind(
      fixture.extractor
    ) as GetDiffMethod;
    const diff = await getDiff(
      fixture.repoPath,
      fixture.run.eventType,
      fixture.run.baseSha!,
      fixture.run.headSha!,
      false
    );

    expect(diff).toContain('feature branch commit one');
    expect(diff).toContain('feature branch commit two');
    expect(diff).not.toContain('main branch only change');
    expect(diff).not.toContain('diff --git a/main-only.txt b/main-only.txt');
  });

  test('getDiff for pull_request incremental=true uses two-dot range', async () => {
    const getDiff = Reflect.get(fixture.extractor, 'getDiff').bind(
      fixture.extractor
    ) as GetDiffMethod;
    const diff = await getDiff(
      fixture.repoPath,
      fixture.run.eventType,
      fixture.run.baseSha!,
      fixture.run.headSha!,
      true
    );

    expect(diff).toContain('feature branch commit one');
    expect(diff).toContain('feature branch commit two');
    expect(diff).toContain('diff --git a/main-only.txt b/main-only.txt');
    expect(diff).toContain('-main branch only change');
  });

  test('getChangedFiles respects incremental flag diff range', async () => {
    const getChangedFiles = Reflect.get(fixture.extractor, 'getChangedFiles').bind(
      fixture.extractor
    ) as GetChangedFilesMethod;

    const threeDotFiles = await getChangedFiles(
      fixture.repoPath,
      fixture.run.baseSha!,
      fixture.run.headSha!,
      false
    );
    const twoDotFiles = await getChangedFiles(
      fixture.repoPath,
      fixture.run.baseSha!,
      fixture.run.headSha!,
      true
    );

    const threeDotPaths = threeDotFiles.map((file) => file.path);
    const twoDotPaths = twoDotFiles.map((file) => file.path);

    expect(threeDotPaths).not.toContain('main-only.txt');
    expect(twoDotPaths).toContain('main-only.txt');
    expect(threeDotPaths).toContain('feature-only.txt');
    expect(twoDotPaths).toContain('feature-only.txt');
  });
});

describe('DiffExtractor token budget clipping', () => {
  let fixture: LargeDiffFixture;

  beforeEach(async () => {
    fixture = await setupLargeDiffRepoFixture();
  });

  afterEach(async () => {
    await rm(fixture.tempDir, { recursive: true, force: true });
  });

  test('buildContext clips raw diff when exceeding MAX_RAW_DIFF_TOKENS', async () => {
    expect(tokenCounter.count(fixture.unclippedDiff)).toBeGreaterThan(30_000);

    const context = await fixture.extractor.buildContext(
      fixture.run,
      fixture.repoPath,
      fixture.repoPath
    );

    expect(context.diff).toContain('[truncated, exceeded 30000 token budget]');
    expect(context.diff.length).toBeLessThan(fixture.unclippedDiff.length);
  });
});
