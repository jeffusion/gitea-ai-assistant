import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import config from '../config';
import { repositoryReviewPromptRepo } from '../db/repositories/repository-review-prompt-repo';
import { reviewEngine } from '../review/engine';
import { giteaService } from '../services/gitea';
import { toErrorLogMeta } from '../utils/error-log';
import { logger } from '../utils/logger';

const publicRoutes = new Hono();
const protectedRoutes = new Hono();

// --- Public Routes ---

// 登录接口
publicRoutes.post('/login', async (c) => {
  const { password } = await c.req.json();

  if (password === config.admin.password) {
    const payload = {
      sub: 'admin', // Subject
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24, // Expiration: 24 hours
    };
    const token = await sign(payload, config.admin.jwtSecret);
    return c.json({ token });
  }

  return c.json({ message: 'Invalid credentials' }, 401);
});

// --- Protected Routes ---

// 获取仓库列表及 Webhook 状态
protectedRoutes.get('/repositories', async (c) => {
  const page = Number.parseInt(c.req.query('page') || '1', 10);
  const query = c.req.query('q');
  const limit = 30; // 每页数量固定，或也可从查询参数获取
  const requestContext = {
    page,
    limit,
    query: query ?? null,
    requestUrl: c.req.url,
    method: c.req.method,
    runtime: process.versions.bun ? `bun-${process.versions.bun}` : process.version,
    nodeEnv: process.env.NODE_ENV ?? null,
    databasePath: process.env.DATABASE_PATH || './data/assistant.db',
  };

  try {
    logger.debug('开始获取仓库列表', requestContext);

    const { repos, totalCount } = await giteaService.listAllRepositories(page, limit, query);
    logger.debug('仓库搜索接口返回成功', {
      ...requestContext,
      reposCount: repos.length,
      totalCount,
      sampleRepos: repos
        .slice(0, 3)
        .map((repo) => (typeof repo.full_name === 'string' ? repo.full_name : null)),
    });

    const webhookUrl = c.req.url.replace(/\/admin\/api\/repositories.*$/, '/webhook/gitea');
    const fullNames = repos
      .map((repo) => (typeof repo.full_name === 'string' ? repo.full_name : null))
      .filter((name): name is string => name !== null);
    logger.debug('准备批量读取项目级提示词', {
      ...requestContext,
      fullNamesCount: fullNames.length,
      fullNamesSample: fullNames.slice(0, 5),
    });

    let promptMap: Record<string, string>;
    try {
      promptMap = repositoryReviewPromptRepo.listProjectPrompts(fullNames);
    } catch (error: unknown) {
      logger.error('批量读取项目级提示词失败', {
        ...requestContext,
        fullNamesCount: fullNames.length,
        fullNamesSample: fullNames.slice(0, 5),
        error: toErrorLogMeta(error),
      });
      throw error;
    }

    const reposWithStatus = await Promise.all(
      repos.map(async (repo) => {
        const [owner, repoName] = repo.full_name.split('/');
        const hooks = await giteaService.listWebhooks(owner, repoName);
        const webhook = hooks.find((h) => h.config.url === webhookUrl);
        return {
          name: repo.full_name,
          webhook_status: webhook ? 'active' : 'inactive',
          hook_id: webhook ? webhook.id : null,
          project_review_prompt: promptMap[repo.full_name] || null,
        };
      })
    );

    reposWithStatus.sort((a, b) => {
      if (a.webhook_status === b.webhook_status) {
        return 0;
      }
      return a.webhook_status === 'active' ? -1 : 1;
    });

    return c.json({
      data: reposWithStatus,
      totalCount,
      page,
      limit,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('获取仓库列表失败:', {
      ...requestContext,
      error: toErrorLogMeta(error),
    });
    return c.json({ message: 'Failed to fetch repositories', error: errorMessage }, 500);
  }
});

protectedRoutes.put('/repositories/:owner/:repo/project-prompt', async (c) => {
  const { owner, repo } = c.req.param();

  try {
    const body = (await c.req.json()) as { project_review_prompt?: unknown };
    if (typeof body.project_review_prompt !== 'string') {
      return c.json({ message: 'project_review_prompt must be a string' }, 400);
    }

    const normalizedPrompt = body.project_review_prompt.trim();
    if (!normalizedPrompt) {
      repositoryReviewPromptRepo.clearProjectPrompt(owner, repo);
      return c.json({ success: true, project_review_prompt: null });
    }

    const updated = repositoryReviewPromptRepo.setProjectPrompt(owner, repo, normalizedPrompt);
    return c.json({ success: true, project_review_prompt: updated.project_prompt });
  } catch (error: any) {
    logger.error(`更新 ${owner}/${repo} 的项目级审查提示词失败:`, error);
    return c.json({ message: 'Failed to update project review prompt', error: error.message }, 500);
  }
});

// 创建 Webhook
protectedRoutes.post('/repositories/:owner/:repo/webhook', async (c) => {
  const { owner, repo } = c.req.param();
  const webhookUrl = `${new URL(c.req.url).origin}/webhook/gitea`;

  try {
    await giteaService.createWebhook(owner, repo, webhookUrl);
    return c.json({ success: true });
  } catch (error: any) {
    logger.error(`为 ${owner}/${repo} 创建 Webhook 失败:`, error);
    return c.json({ message: 'Failed to create webhook', error: error.message }, 500);
  }
});

// 删除 Webhook
protectedRoutes.delete('/repositories/:owner/:repo/webhook/:hookId', async (c) => {
  const { owner, repo, hookId } = c.req.param();

  try {
    await giteaService.deleteWebhook(owner, repo, Number.parseInt(hookId, 10));
    return c.json({ success: true });
  } catch (error: any) {
    logger.error(`删除 ${owner}/${repo} 的 Webhook 失败:`, error);
    return c.json({ message: 'Failed to delete webhook', error: error.message }, 500);
  }
});

// 查询审查任务
protectedRoutes.get('/review/runs', async (c) => {
  try {
    const limit = Number.parseInt(c.req.query('limit') || '50', 10);
    const runs = await reviewEngine.listRuns(limit);
    return c.json({ data: runs });
  } catch (error: any) {
    logger.error('获取审查任务列表失败:', error);
    return c.json({ message: 'Failed to fetch review runs', error: error.message }, 500);
  }
});

// 查询审查任务详情
protectedRoutes.get('/review/runs/:runId', async (c) => {
  try {
    const { runId } = c.req.param();
    const result = await reviewEngine.getRunDetails(runId);
    if (!result) {
      return c.json({ message: 'Run not found' }, 404);
    }
    return c.json(result);
  } catch (error: any) {
    logger.error('获取审查任务详情失败:', error);
    return c.json({ message: 'Failed to fetch review run details', error: error.message }, 500);
  }
});

export const adminController = {
  publicRoutes,
  protectedRoutes,
};
