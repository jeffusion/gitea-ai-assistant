import type { Database } from 'bun:sqlite';
import type { Migration } from '../database';

export const migration003RepositoryReviewPrompts: Migration = {
  version: 3,
  name: 'add_repository_review_prompts',

  up(db: Database): void {
    db.exec(`
      CREATE TABLE repository_review_prompts (
        full_name      TEXT PRIMARY KEY,
        project_prompt TEXT NOT NULL,
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.exec(
      'CREATE INDEX idx_repository_review_prompts_updated_at ON repository_review_prompts(updated_at)'
    );
  },
};
