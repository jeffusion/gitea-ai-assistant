import { Hono } from 'hono';
import { handleGiteaWebhook } from './controllers/review';
import config from './config';

// 创建Hono应用实例
const app = new Hono();

// 健康检查路由
app.get('/', (c) => {
  const webhookSecretConfigured = !!config.app.webhookSecret;

  return c.json({
    status: 'ok',
    message: 'AI Code Review 服务运行中',
    version: '2.0.0',
    webhookSecurityEnabled: webhookSecretConfigured,
    configuration: {
      webhookEndpoints: {
        unified: '/webhook/gitea (支持Pull Request和Commit Status事件)'
      },
      signature: webhookSecretConfigured
        ? '签名验证已启用 (使用X-Gitea-Signature头)'
        : '警告: 签名验证未配置，建议设置WEBHOOK_SECRET环境变量'
    }
  });
});

// 统一的Gitea webhook路由 - 处理所有事件类型
app.post('/webhook/gitea', handleGiteaWebhook);

// 启动服务器
const port = config.app.port;
console.log(`⚡️ 服务启动在 http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
