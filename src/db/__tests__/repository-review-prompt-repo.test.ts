import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getDatabase, initDatabase } from '../database';
import { repositoryReviewPromptRepo } from '../repositories/repository-review-prompt-repo';

describe('repository-review-prompt-repo', () => {
  let dbPath: string;
  const savedDbPath = process.env.DATABASE_PATH;

  beforeEach(() => {
    const tmpDir = join(tmpdir(), `db-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, 'test.db');
    process.env.DATABASE_PATH = dbPath;
    initDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (savedDbPath === undefined) {
      Reflect.deleteProperty(process.env, 'DATABASE_PATH');
    } else {
      process.env.DATABASE_PATH = savedDbPath;
    }

    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
  });

  test('sets and gets project prompt by owner/repo', () => {
    repositoryReviewPromptRepo.setProjectPrompt('acme', 'assistant', 'focus on API correctness');

    const prompt = repositoryReviewPromptRepo.getProjectPrompt('acme', 'assistant');
    expect(prompt).toBe('focus on API correctness');
  });

  test('normalizes surrounding whitespace when setting prompt', () => {
    repositoryReviewPromptRepo.setProjectPrompt('acme', 'assistant', '  use chinese output  ');

    const row = repositoryReviewPromptRepo.getByFullName('acme/assistant');
    expect(row?.project_prompt).toBe('use chinese output');
  });

  test('clears prompt for repository', () => {
    repositoryReviewPromptRepo.setProjectPrompt('acme', 'assistant', 'focus on security');
    const deleted = repositoryReviewPromptRepo.clearProjectPrompt('acme', 'assistant');

    expect(deleted).toBe(true);
    expect(repositoryReviewPromptRepo.getProjectPrompt('acme', 'assistant')).toBeUndefined();
  });

  test('lists prompt map for repository names', () => {
    repositoryReviewPromptRepo.setProjectPrompt('acme', 'a', 'prompt-a');
    repositoryReviewPromptRepo.setProjectPrompt('acme', 'b', 'prompt-b');

    const map = repositoryReviewPromptRepo.listProjectPrompts(['acme/a', 'acme/b', 'acme/c']);

    expect(map).toEqual({
      'acme/a': 'prompt-a',
      'acme/b': 'prompt-b',
    });
  });

  test('self-heals missing prompt table and keeps repository listing readable', () => {
    const db = getDatabase();
    db.exec('DROP TABLE repository_review_prompts');

    const map = repositoryReviewPromptRepo.listProjectPrompts(['acme/a']);
    expect(map).toEqual({});

    repositoryReviewPromptRepo.setProjectPrompt('acme', 'a', 'prompt-a');
    expect(repositoryReviewPromptRepo.getProjectPrompt('acme', 'a')).toBe('prompt-a');
  });

  test('self-heals missing prompt table for direct prompt write path', () => {
    const db = getDatabase();
    db.exec('DROP TABLE repository_review_prompts');

    const row = repositoryReviewPromptRepo.setProjectPrompt(
      'acme',
      'direct-write',
      'prompt-direct'
    );
    expect(row.project_prompt).toBe('prompt-direct');
    expect(repositoryReviewPromptRepo.getProjectPrompt('acme', 'direct-write')).toBe(
      'prompt-direct'
    );
  });
});
