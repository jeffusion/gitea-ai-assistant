import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import config from '@/config';
import { giteaService } from '@/services/gitea';
import { logger } from '@/utils/logger';

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
  try {
    const page = parseInt(c.req.query('page') || '1', 10);
    const query = c.req.query('q');
    const limit = 30; // 每页数量固定，或也可从查询参数获取

    const { repos, totalCount } = await giteaService.listAllRepositories(page, limit, query);
    const webhookUrl = c.req.url.replace(/\/admin\/api\/repositories.*$/, '/webhook/gitea');

    const reposWithStatus = await Promise.all(
      repos.map(async (repo) => {
        const [owner, repoName] = repo.full_name.split('/');
        const hooks = await giteaService.listWebhooks(owner, repoName);
        const webhook = hooks.find(h => h.config.url === webhookUrl);
        return {
          name: repo.full_name,
          webhook_status: webhook ? 'active' : 'inactive',
          hook_id: webhook ? webhook.id : null,
        };
      })
    );

    return c.json({
      data: reposWithStatus,
      totalCount,
      page,
      limit,
    });
  } catch (error: any) {
    logger.error('获取仓库列表失败:', error);
    return c.json({ message: 'Failed to fetch repositories', error: error.message }, 500);
  }
});

// 创建 Webhook
protectedRoutes.post('/repositories/:owner/:repo/webhook', async (c) => {
  const { owner, repo } = c.req.param();
  const webhookUrl = new URL(c.req.url).origin + '/webhook/gitea';

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
    await giteaService.deleteWebhook(owner, repo, parseInt(hookId, 10));
    return c.json({ success: true });
  } catch (error: any) {
    logger.error(`删除 ${owner}/${repo} 的 Webhook 失败:`, error);
    return c.json({ message: 'Failed to delete webhook', error: error.message }, 500);
  }
});

export const adminController = {
  publicRoutes,
  protectedRoutes,
};
