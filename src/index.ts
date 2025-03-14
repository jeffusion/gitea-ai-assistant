import { Hono } from 'hono';
import { handlePullRequestEvent } from './controllers/review';
import config from './config';

// 创建Hono应用实例
const app = new Hono();

// 健康检查路由
app.get('/', (c) => {
  return c.json({ status: 'ok', message: 'AI Code Review 服务运行中' });
});

// Gitea webhook路由
app.post('/webhook/gitea', handlePullRequestEvent);

// 启动服务器
const port = config.app.port;
console.log(`⚡️ 服务启动在 http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
