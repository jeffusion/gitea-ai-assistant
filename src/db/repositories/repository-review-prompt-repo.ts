import { getDatabase } from '../database';

export interface RepositoryReviewPromptRow {
  full_name: string;
  project_prompt: string;
  updated_at: string;
}

function toFullName(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

export const repositoryReviewPromptRepo = {
  getByFullName(fullName: string): RepositoryReviewPromptRow | null {
    const db = getDatabase();
    return (
      (db
        .query(
          'SELECT full_name, project_prompt, updated_at FROM repository_review_prompts WHERE full_name = ?'
        )
        .get(fullName) as RepositoryReviewPromptRow | null) || null
    );
  },

  getProjectPrompt(owner: string, repo: string): string | undefined {
    const row = this.getByFullName(toFullName(owner, repo));
    if (!row) return undefined;
    const normalized = row.project_prompt.trim();
    return normalized.length > 0 ? normalized : undefined;
  },

  upsertByFullName(fullName: string, projectPrompt: string): RepositoryReviewPromptRow {
    const db = getDatabase();
    const normalized = projectPrompt.trim();
    if (!normalized) {
      throw new Error('projectPrompt must be non-empty');
    }

    db.query(
      `INSERT INTO repository_review_prompts (full_name, project_prompt, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(full_name) DO UPDATE SET
         project_prompt = excluded.project_prompt,
         updated_at = datetime('now')`
    ).run(fullName, normalized);

    const row = this.getByFullName(fullName);
    if (!row) {
      throw new Error('Failed to load repository review prompt after upsert');
    }
    return row;
  },

  setProjectPrompt(owner: string, repo: string, projectPrompt: string): RepositoryReviewPromptRow {
    return this.upsertByFullName(toFullName(owner, repo), projectPrompt);
  },

  deleteByFullName(fullName: string): boolean {
    const db = getDatabase();
    const result = db
      .query('DELETE FROM repository_review_prompts WHERE full_name = ?')
      .run(fullName);
    return result.changes > 0;
  },

  clearProjectPrompt(owner: string, repo: string): boolean {
    return this.deleteByFullName(toFullName(owner, repo));
  },

  listProjectPrompts(fullNames: string[]): Record<string, string> {
    if (fullNames.length === 0) {
      return {};
    }

    const db = getDatabase();
    const placeholders = fullNames.map(() => '?').join(', ');
    const rows = db
      .query(
        `SELECT full_name, project_prompt
         FROM repository_review_prompts
         WHERE full_name IN (${placeholders})`
      )
      .all(...fullNames) as Array<Pick<RepositoryReviewPromptRow, 'full_name' | 'project_prompt'>>;

    const map: Record<string, string> = {};
    for (const row of rows) {
      const normalized = row.project_prompt.trim();
      if (normalized) {
        map[row.full_name] = normalized;
      }
    }
    return map;
  },
};
