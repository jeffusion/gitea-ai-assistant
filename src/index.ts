import { Hono } from 'hono';
import { jwt } from 'hono/jwt';
import { serveStatic } from 'hono/bun';
import { handleGiteaWebhook } from './controllers/review';
import { adminController } from './controllers/admin';
import config from './config';

// 创建Hono应用实例
const app = new Hono();

// --- API 路由 ---

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

// 管理后台API路由
// 公开路由 (例如 /login)
app.route('/admin/api', adminController.publicRoutes);

// 受保护的路由
const adminProtected = new Hono();
adminProtected.use('/*', jwt({ secret: config.admin.jwtSecret }));
adminProtected.route('/', adminController.protectedRoutes);
app.route('/admin/api', adminProtected);


// --- 前端静态文件服务 ---

// 优先服务于 public 目录下的静态文件
app.use('/*', serveStatic({ root: './public' }));

// 对于所有未匹配到的GET请求，返回 index.html，以支持SPA路由
app.get('*', serveStatic({ path: './public/index.html' }));


// 启动服务器
const port = config.app.port;
console.log(`⚡️ 服务启动在 http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
