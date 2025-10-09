import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import config from '@/config';
import { giteaService } from '@/services/gitea';
import { configService } from '@/services/configService';
import { CONFIG_GROUPS } from '@/types/config';
import { logger } from '@/utils/logger';
import { generateWebhookUrl } from '@/utils/webhook';

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
    const webhookUrl = await generateWebhookUrl(new URL(c.req.url).origin);

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
  const webhookUrl = await generateWebhookUrl(new URL(c.req.url).origin);

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

// --- 配置管理 API ---

// 获取UI可管理的配置
protectedRoutes.get('/config', async (c) => {
  try {
    const configs = await configService.getUIManageableConfigs();

    // 按分组组织配置
    const groupedConfigs: Record<string, any> = {};
    for (const [groupKey, group] of Object.entries(CONFIG_GROUPS)) {
      groupedConfigs[groupKey] = {
        title: group.title,
        description: group.description,
        configs: {}
      };

      for (const configKey of group.configs) {
        if (configs[configKey]) {
          groupedConfigs[groupKey].configs[configKey] = configs[configKey];
        }
      }
    }

    return c.json({
      success: true,
      data: {
        grouped: groupedConfigs,
        all: configs
      }
    });
  } catch (error: any) {
    logger.error('获取配置失败:', error);
    return c.json({ message: 'Failed to get config', error: error.message }, 500);
  }
});

// 更新单个配置
protectedRoutes.put('/config/:key', async (c) => {
  try {
    const { key } = c.req.param();
    const { value } = await c.req.json();

    // 验证配置
    const validation = await configService.validateConfig(key, value);
    if (!validation.valid) {
      return c.json({ message: validation.error }, 400);
    }

    await configService.updateConfig(key, value, 'admin');
    return c.json({ success: true });
  } catch (error: any) {
    logger.error(`更新配置 ${c.req.param('key')} 失败:`, error);
    return c.json({
      message: 'Failed to update config',
      error: error.message
    }, error.message.includes('不允许通过界面修改') ? 403 : 500);
  }
});

// 批量更新配置
protectedRoutes.put('/config', async (c) => {
  try {
    const { configs } = await c.req.json();

    if (!configs || typeof configs !== 'object') {
      return c.json({ message: 'Invalid configs format' }, 400);
    }

    // 验证所有配置
    for (const [key, value] of Object.entries(configs)) {
      const validation = await configService.validateConfig(key, value);
      if (!validation.valid) {
        return c.json({ message: `配置 ${key}: ${validation.error}` }, 400);
      }
    }

    await configService.batchUpdateConfigs(configs, 'admin');
    return c.json({ success: true });
  } catch (error: any) {
    logger.error('批量更新配置失败:', error);
    return c.json({ message: 'Failed to update configs', error: error.message }, 500);
  }
});

// 验证配置值
protectedRoutes.post('/config/validate', async (c) => {
  try {
    const { key, value } = await c.req.json();
    const validation = await configService.validateConfig(key, value);
    return c.json({
      valid: validation.valid,
      error: validation.error
    });
  } catch (error: any) {
    return c.json({ message: 'Validation failed', error: error.message }, 500);
  }
});

// 获取配置元数据
protectedRoutes.get('/config/metadata', async (c) => {
  try {
    const metadata = configService.getAllConfigMetadata();
    return c.json({
      success: true,
      data: metadata
    });
  } catch (error: any) {
    return c.json({ message: 'Failed to get metadata', error: error.message }, 500);
  }
});

export const adminController = {
  publicRoutes,
  protectedRoutes,
};
