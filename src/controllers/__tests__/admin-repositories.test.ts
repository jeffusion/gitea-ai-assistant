import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { repositoryReviewPromptRepo } from '../../db/repositories/repository-review-prompt-repo';
import { giteaService } from '../../services/gitea';
import { adminController } from '../admin';

type RepoRecord = { full_name: string };
type HookRecord = { id: number; config: { url: string } };

function createTestApp(): Hono {
  const app = new Hono();
  app.route('/admin/api', adminController.protectedRoutes);
  return app;
}

describe('admin repositories route', () => {
  const originalListAllRepositories = giteaService.listAllRepositories;
  const originalListWebhooks = giteaService.listWebhooks;
  const originalListProjectPrompts = repositoryReviewPromptRepo.listProjectPrompts;

  beforeEach(() => {
    const repos: RepoRecord[] = [
      { full_name: 'team/inactive-alpha' },
      { full_name: 'team/active-beta' },
      { full_name: 'team/inactive-gamma' },
      { full_name: 'team/active-delta' },
    ];

    giteaService.listAllRepositories = async () => ({
      repos,
      totalCount: repos.length,
    });

    giteaService.listWebhooks = async (_owner: string, repo: string) => {
      if (repo.startsWith('active-')) {
        return [{ id: 101, config: { url: 'http://localhost/webhook/gitea' } }] as HookRecord[];
      }
      return [] as HookRecord[];
    };

    repositoryReviewPromptRepo.listProjectPrompts = () => ({
      'team/active-beta': 'focus security',
    });
  });

  afterEach(() => {
    giteaService.listAllRepositories = originalListAllRepositories;
    giteaService.listWebhooks = originalListWebhooks;
    repositoryReviewPromptRepo.listProjectPrompts = originalListProjectPrompts;
  });

  test('returns active webhook repositories first', async () => {
    const app = createTestApp();
    const response = await app.request('http://localhost/admin/api/repositories?page=1');
    const payload = (await response.json()) as {
      data: Array<{
        name: string;
        webhook_status: 'active' | 'inactive';
        hook_id: number | null;
        project_review_prompt: string | null;
      }>;
      totalCount: number;
      page: number;
      limit: number;
    };

    expect(response.status).toBe(200);
    expect(payload.totalCount).toBe(4);
    expect(payload.page).toBe(1);
    expect(payload.limit).toBe(30);
    expect(payload.data.map((repo) => repo.name)).toEqual([
      'team/active-beta',
      'team/active-delta',
      'team/inactive-alpha',
      'team/inactive-gamma',
    ]);
    expect(payload.data.map((repo) => repo.webhook_status)).toEqual([
      'active',
      'active',
      'inactive',
      'inactive',
    ]);
    expect(payload.data[0]?.project_review_prompt).toBe('focus security');
    expect(payload.data[1]?.project_review_prompt).toBeNull();
  });
});
