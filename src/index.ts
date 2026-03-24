import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { jwt } from 'hono/jwt';
import config, { configManager } from './config';
import { adminController } from './controllers/admin';
import { configRouter } from './controllers/config';
import { feedbackRouter, initializeFeedbackSystem } from './controllers/feedback';
import { llmConfigRouter } from './controllers/llm-config';
import { handleGiteaWebhook } from './controllers/review';
import { initMasterKey } from './crypto/secrets';
import { initDatabase } from './db/database';
import { cleanupScheduler } from './review/cleanup-scheduler';
import { codexEngine } from './review/codex/codex-engine';
import { mcpRouter } from './review/codex/mcp-handler';
import { reviewEngine } from './review/engine';

initMasterKey();
initDatabase();
configManager.seedDefaults();

// 创建Hono应用实例
const app = new Hono();

// --- API 路由 ---

// 健康检查路由
app.get('/api/health', (c) => {
  const webhookSecretConfigured = !!config.app.webhookSecret;

  return c.json({
    status: 'ok',
    message: 'AI Code Review 服务运行中',
    version: '2.0.0',
    webhookSecurityEnabled: webhookSecretConfigured,
    configuration: {
      webhookEndpoints: {
        unified: '/webhook/gitea (支持Pull Request和Commit Status事件)',
      },
      signature: webhookSecretConfigured
        ? '签名验证已启用 (使用X-Gitea-Signature头)'
        : '警告: 签名验证未配置，建议在管理后台设置 Webhook 密钥',
    },
  });
});

// MCP 端点（Codex 审查引擎使用，无需认证）
app.route('/mcp/gitea-review', mcpRouter);

// 统一的Gitea webhook路由 - 处理所有事件类型
app.post('/webhook/gitea', handleGiteaWebhook);

// 管理后台API路由
// 公开路由 (例如 /login)
app.route('/admin/api', adminController.publicRoutes);

// 受保护的路由
const adminProtected = new Hono();
adminProtected.use('/*', (c, next) => {
  const jwtMiddleware = jwt({ secret: config.admin.jwtSecret, alg: 'HS256' });
  return jwtMiddleware(c, next);
});
adminProtected.route('/', adminController.protectedRoutes);
adminProtected.route('/feedback', feedbackRouter);
adminProtected.route('/config', configRouter);
adminProtected.route('/llm', llmConfigRouter);
app.route('/admin/api', adminProtected);

// --- 前端静态文件服务 ---

// 优先服务于 public 目录下的静态文件
app.use('/*', serveStatic({ root: './public' }));

// 对于所有未匹配到的GET请求，返回 index.html，以支持SPA路由
app.get('*', serveStatic({ path: './public/index.html' }));

// 启动服务器
const port = config.app.port;
console.log(`⚡️ 服务启动在 http://localhost:${port}`);

// 启动审查引擎（根据配置选择）
reviewEngine.start().catch((error) => {
  console.error('❌ 启动Agent Review Engine失败', error);
});
codexEngine.start().catch((error) => {
  console.error('❌ 启动Codex Review Engine失败', error);
});

// 启动清理调度器（定期清理过期 mirror/workspace 目录）
cleanupScheduler.start();

// 初始化反馈系统（总是初始化，记忆系统可选）
const reviewStore = reviewEngine.getStore();
initializeFeedbackSystem(reviewStore);

if (config.review.enableMemory) {
  console.log('✅ 反馈系统已初始化（含向量记忆）');
} else {
  console.log('✅ 反馈系统已初始化（不含向量记忆）');
}

export default {
  port,
  fetch: app.fetch,
};
