# AI Code Review for Gitea

基于Bun和TypeScript的Gitea代码审查助手，自动为Pull Request和单个提交提供AI驱动的代码审查。

## 功能特点

- ✅ 自动对Gitea Pull Request进行代码审查
- ✅ 自动对成功状态的单个提交进行代码审查
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
- `CUSTOM_SUMMARY_PROMPT`: 自定义总结审查提示 (可选)
- `CUSTOM_LINE_COMMENT_PROMPT`: 自定义行评论提示 (可选)
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

   在Gitea仓库设置中添加两个Webhook:

   **Pull Request审查webhook**:
   - URL: `http://your-server:3000/webhook/gitea/pull_request`
   - 内容类型: `application/json`
   - 秘钥: 设置为与`WEBHOOK_SECRET`环境变量相同的值
   - 触发事件: 选择"Pull Request"

   **提交状态审查webhook**:
   - URL: `http://your-server:3000/webhook/gitea/status`
   - 内容类型: `application/json`
   - 秘钥: 设置为与`WEBHOOK_SECRET`环境变量相同的值
   - 触发事件: 选择"Status"

   > 注意: 老端点 `/webhook/gitea` 仍然支持Pull Request审查，但仅作向后兼容使用。

### Webhook签名验证

为确保请求安全，系统使用Gitea的Webhook签名验证机制：

1. 设置环境变量`WEBHOOK_SECRET`为一个安全的随机字符串
2. 在Gitea的Webhook配置中，使用相同的字符串作为"秘钥"
3. 每次请求时，系统会验证请求头中的`X-Gitea-Signature`
4. 如果签名验证失败，请求会被拒绝处理

验证方法使用SHA-256哈希算法，在处理高负载的情况下这能防止恶意请求并保证请求来源的真实性。

## 功能说明

### PR代码审查

当PR被创建或更新时，系统会自动进行代码审查，提供总体评价和行级评论。

### 单个提交审查

当提交状态变为"success"（如CI通过）时，系统会：

1. 对该提交进行代码审查
2. 提供总体评价作为提交评论
3. 尝试找到关联的PR，添加行级评论

这对于增量工作尤其有用，可以只对最新的变更进行审查，避免重复评审已审查过的代码。

## 开发

- `bun run dev`: 开发模式运行
- `bun run build`: 构建项目
- `bun run start`: 生产模式运行
- `bun run lint`: 运行代码风格检查

## 许可证

MIT

## 自定义AI审查提示

默认情况下，AI代码审查工具配置为只对明显的bug和严重问题进行评论。你可以通过环境变量自定义AI使用的提示：

### 自定义总结提示

设置`CUSTOM_SUMMARY_PROMPT`环境变量来自定义代码审查总结。你可以在提示中使用以下变量，它们会在运行时被自动替换：

- `${context.diffContent}` - 代码差异内容
- `${JSON.stringify(fileInfo, null, 2)}` - 变更文件的完整信息

### 自定义行评论提示

设置`CUSTOM_LINE_COMMENT_PROMPT`环境变量来自定义行级评论生成。你可以在提示中使用以下变量：

- `${file.path}` - 当前文件路径
- `${fileContent}` - 文件的完整内容
- `${file.changes.map(c => `${c.lineNumber}: ${c.content} (${c.type === 'add' ? '新增' : '上下文'})`).join('\n')}` - 变更行的上下文

请确保你的自定义提示返回正确的格式，特别是对于行评论，必须返回有效的JSON数组。
