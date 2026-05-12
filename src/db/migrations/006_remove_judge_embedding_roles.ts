import type { Database } from 'bun:sqlite';
import type { Migration } from '../database';

const ALLOWED_ROLES = "'planner','specialist'";

export const migration006RemoveJudgeEmbeddingRoles: Migration = {
  version: 6,
  name: 'remove_judge_embedding_roles',

  up(db: Database): void {
    db.exec(`
      CREATE TABLE model_role_assignments_new (
        role TEXT PRIMARY KEY CHECK (role IN (${ALLOWED_ROLES})),
        provider_id TEXT NOT NULL REFERENCES llm_providers(id),
        model TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.exec(`
      INSERT INTO model_role_assignments_new (role, provider_id, model, updated_at)
      SELECT role, provider_id, model, updated_at
      FROM model_role_assignments
      WHERE role IN (${ALLOWED_ROLES})
    `);

    db.exec('DROP TABLE model_role_assignments');
    db.exec('ALTER TABLE model_role_assignments_new RENAME TO model_role_assignments');
  },
};
