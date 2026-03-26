import { toErrorLogMeta } from '../../utils/error-log';
import { logger } from '../../utils/logger';
import { ensureRepositoryReviewPromptsSchema, getDatabase } from '../database';

export interface RepositoryReviewPromptRow {
  full_name: string;
  project_prompt: string;
  updated_at: string;
}

function toFullName(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function isMissingPromptTableError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('no such table: repository_review_prompts')
  );
}

function withPromptTableHeal<T>(operation: string, run: () => T): T {
  try {
    return run();
  } catch (error: unknown) {
    if (!isMissingPromptTableError(error)) {
      throw error;
    }

    logger.warn('检测到 repository_review_prompts 表缺失，尝试自愈建表后重试', {
      operation,
      databasePath: process.env.DATABASE_PATH || './data/assistant.db',
      error: toErrorLogMeta(error),
    });

    ensureRepositoryReviewPromptsSchema();
    return run();
  }
}

export const repositoryReviewPromptRepo = {
  getByFullName(fullName: string): RepositoryReviewPromptRow | null {
    return withPromptTableHeal('getByFullName', () => {
      const db = getDatabase();
      return (
        (db
          .query(
            'SELECT full_name, project_prompt, updated_at FROM repository_review_prompts WHERE full_name = ?'
          )
          .get(fullName) as RepositoryReviewPromptRow | null) || null
      );
    });
  },

  getProjectPrompt(owner: string, repo: string): string | undefined {
    const row = this.getByFullName(toFullName(owner, repo));
    if (!row) return undefined;
    const normalized = row.project_prompt.trim();
    return normalized.length > 0 ? normalized : undefined;
  },

  upsertByFullName(fullName: string, projectPrompt: string): RepositoryReviewPromptRow {
    const normalized = projectPrompt.trim();
    if (!normalized) {
      throw new Error('projectPrompt must be non-empty');
    }

    return withPromptTableHeal('upsertByFullName', () => {
      const db = getDatabase();
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
    });
  },

  setProjectPrompt(owner: string, repo: string, projectPrompt: string): RepositoryReviewPromptRow {
    return this.upsertByFullName(toFullName(owner, repo), projectPrompt);
  },

  deleteByFullName(fullName: string): boolean {
    return withPromptTableHeal('deleteByFullName', () => {
      const db = getDatabase();
      const result = db
        .query('DELETE FROM repository_review_prompts WHERE full_name = ?')
        .run(fullName);
      return result.changes > 0;
    });
  },

  clearProjectPrompt(owner: string, repo: string): boolean {
    return this.deleteByFullName(toFullName(owner, repo));
  },

  listProjectPrompts(fullNames: string[]): Record<string, string> {
    if (fullNames.length === 0) {
      return {};
    }

    const db = getDatabase();
    const loadPromptMap = (): Record<string, string> => {
      const placeholders = fullNames.map(() => '?').join(', ');
      const rows = db
        .query(
          `SELECT full_name, project_prompt
           FROM repository_review_prompts
           WHERE full_name IN (${placeholders})`
        )
        .all(...fullNames) as Array<
        Pick<RepositoryReviewPromptRow, 'full_name' | 'project_prompt'>
      >;

      const map: Record<string, string> = {};
      for (const row of rows) {
        const normalized = row.project_prompt.trim();
        if (normalized) {
          map[row.full_name] = normalized;
        }
      }

      return map;
    };

    try {
      return loadPromptMap();
    } catch (error: unknown) {
      if (isMissingPromptTableError(error)) {
        logger.warn('检测到 repository_review_prompts 表缺失，尝试自愈建表后重试', {
          fullNamesCount: fullNames.length,
          fullNamesSample: fullNames.slice(0, 5),
          databasePath: process.env.DATABASE_PATH || './data/assistant.db',
        });

        try {
          ensureRepositoryReviewPromptsSchema(db);
          return loadPromptMap();
        } catch (healError: unknown) {
          logger.error('自愈 repository_review_prompts 表后重试失败，降级返回空提示词映射', {
            fullNamesCount: fullNames.length,
            fullNamesSample: fullNames.slice(0, 5),
            databasePath: process.env.DATABASE_PATH || './data/assistant.db',
            originalError: toErrorLogMeta(error),
            healError: toErrorLogMeta(healError),
          });
          return {};
        }
      }

      let tableExists: boolean | null = null;
      let latestMigrationVersion: number | null = null;

      try {
        const tableRow = db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get('repository_review_prompts') as { name?: string } | null;
        tableExists = tableRow?.name === 'repository_review_prompts';

        const migrationRow = db
          .query('SELECT version FROM _migrations ORDER BY version DESC LIMIT 1')
          .get() as { version?: number } | null;
        latestMigrationVersion = migrationRow?.version ?? null;
      } catch (inspectError: unknown) {
        logger.warn('查询项目级提示词失败后，诊断数据库状态时发生错误', {
          inspectError: toErrorLogMeta(inspectError),
        });
      }

      logger.error('批量查询项目级提示词失败', {
        fullNamesCount: fullNames.length,
        fullNamesSample: fullNames.slice(0, 5),
        tableExists,
        latestMigrationVersion,
        databasePath: process.env.DATABASE_PATH || './data/assistant.db',
        error: toErrorLogMeta(error),
      });

      throw error;
    }
  },
};
