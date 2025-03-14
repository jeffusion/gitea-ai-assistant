# AI Code Review for Gitea

基于Bun和TypeScript的Gitea代码审查助手，自动为Pull Request提供AI驱动的代码审查。

## 功能特点

- ✅ 自动对Gitea Pull Request进行代码审查
- ✅ 使用OpenAI API进行代码分析
- ✅ 提供总体代码审查评论
- ✅ 支持代码行级别评论
- ✅ 安全的Webhook验证

## 技术栈

- Bun
- TypeScript
- Hono (轻量级Web框架)
- OpenAI API
- Gitea API

## 安装

1. 克隆仓库

   ```bash
   git clone <repository-url>
   cd ai-review
   ```

2. 安装依赖

   ```bash
   bun install
   ```

3. 配置环境变量

   复制.env.example文件为.env并填写必要配置：

   ```bash
   cp .env.example .env
   ```

   编辑.env文件，填写Gitea和OpenAI相关配置。

## 配置项

- `GITEA_API_URL`: Gitea API URL (例如: `http://your-gitea-instance.com/api/v1`)
- `GITEA_ACCESS_TOKEN`: Gitea 访问令牌
- `OPENAI_BASE_URL`: OpenAI 请求地址
- `OPENAI_API_KEY`: OpenAI API密钥
- `OPENAI_MODEL`：OpenAI 使用模型
- `PORT`: 应用监听端口 (默认: 3000)
- `WEBHOOK_SECRET`: Webhook秘钥，用于验证请求来源

## 使用方法

1. 启动服务

   ```bash
   bun run dev  # 开发模式
   # 或
   bun run start  # 生产模式
   ```

2. 在Gitea仓库中配置Webhook

   在Gitea仓库设置中添加Webhook:

   - URL: `http://your-server:3000/webhook/gitea`
   - 内容类型: `application/json`
   - 秘钥: 设置为与WEBHOOK_SECRET相同的值
   - 触发事件: 选择"Pull Request"

## 开发

- `bun run dev`: 开发模式运行
- `bun run build`: 构建项目
- `bun run start`: 生产模式运行
- `bun run lint`: 运行代码风格检查

## 许可证

MIT
