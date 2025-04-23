# Gitea Assistant

Gitea功能增强助手，基于Bun和TypeScript开发，提供AI驱动的代码审查等增强功能。本工具通过Webhook与Gitea集成，自动对Pull Request和提交进行代码审查，并提供智能化的代码质量分析。

## 功能特点

- ✅ 自动对Gitea Pull Request进行代码审查
- ✅ 自动对成功状态的单个提交进行代码审查
- ✅ 使用OpenAI API进行代码分析
- ✅ 提供总体代码审查评论
- ✅ 支持代码行级别评论
- ✅ 安全的Webhook验证
- ✅ 飞书通知集成
- ✅ 异步处理机制
- ✅ 智能PR关联分析
- ✅ 灵活的审查规则配置

## 架构设计

### 核心组件

1. **Webhook处理层**
   - 统一的Webhook端点处理
   - 事件类型自动识别
   - 请求签名验证
   - 异步处理机制

2. **代码审查引擎**
   - 差异分析
   - 文件变更追踪
   - 智能PR关联
   - 审查结果格式化

3. **AI集成层**
   - OpenAI API集成
   - 可配置的提示模板
   - 结果解析和格式化
   - 错误处理和重试机制

4. **通知系统**
   - 飞书Webhook集成
   - 多类型通知支持
   - 通知模板配置
   - 失败重试机制

### 安全特性

- Webhook请求签名验证
- 环境变量配置管理
- 敏感信息保护
- 开发环境安全控制
- 防时序攻击保护

### 性能优化

- 异步处理机制
- 批量处理优化
- 缓存策略
- 资源使用监控
- 错误重试机制

### 扩展性

- 模块化设计
- 插件化架构
- 配置驱动
- 自定义审查规则
- 多通知渠道支持

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
- `FEISHU_WEBHOOK_URL`: 飞书Webhook地址，用于发送通知
- `FEISHU_WEBHOOK_SECRET`: 飞书Webhook秘钥 (可选)

## 使用方法

1. 启动服务

   ```bash
   bun run dev  # 开发模式
   # 或
   bun run start  # 生产模式
   ```

2. 在Gitea仓库中配置Webhook

   在Gitea仓库设置中添加Webhook:

   **统一Webhook端点**:
   - URL: `http://your-server:3000/webhook/gitea`
   - 内容类型: `application/json`
   - 秘钥: 设置为与`WEBHOOK_SECRET`环境变量相同的值
   - 触发事件: 选择"Pull Request"和"Status"事件

   > 注意: 系统使用统一的webhook端点处理所有事件类型，包括Pull Request和Commit Status事件。

### Webhook签名验证

为确保请求安全，系统使用Gitea的Webhook签名验证机制：

1. 设置环境变量`WEBHOOK_SECRET`为一个安全的随机字符串
2. 在Gitea的Webhook配置中，使用相同的字符串作为"秘钥"
3. 每次请求时，系统会验证请求头中的`X-Gitea-Signature`
4. 如果签名验证失败，请求会被拒绝处理
5. 在开发环境下（`NODE_ENV=development`），如果没有提供签名，系统会跳过验证

验证方法使用SHA-256哈希算法，在处理高负载的情况下这能防止恶意请求并保证请求来源的真实性。

## 功能说明

### PR代码审查

当PR被创建或更新时，系统会自动进行代码审查，提供总体评价和行级评论。

### PR通知功能

系统支持通过飞书发送PR相关的通知：

1. **PR创建通知**
   - 当PR被创建且有指定审阅者时
   - 通知内容包括PR标题和链接
   - 通知会发送给所有指定的审阅者

2. **PR审阅者指派通知**
   - 当有新的审阅者被指派到PR时
   - 通知内容包括PR标题和链接
   - 通知会发送给新指派的审阅者

### 单个提交审查

当提交状态变为"success"（如CI通过）时，系统会：

1. 对该提交进行代码审查
2. 提供总体评价作为提交评论
3. 尝试找到关联的PR，添加行级评论

这对于增量工作尤其有用，可以只对最新的变更进行审查，避免重复评审已审查过的代码。

## 代码审查规则

### 总体评价规则

系统会从以下几个方面对代码进行总体评价：

1. **代码质量**
   - 代码结构是否清晰
   - 命名是否规范
   - 代码是否易于维护
   - 是否有重复代码

2. **潜在问题**
   - 是否存在明显的逻辑错误
   - 是否有未处理的异常情况
   - 是否有边界条件未考虑

3. **性能考虑**
   - 是否存在性能瓶颈
   - 是否有不必要的计算或循环
   - 内存使用是否合理

4. **安全性**
   - 是否有潜在的安全漏洞
   - 敏感信息处理是否安全
   - 输入验证是否充分

5. **最佳实践**
   - 是否符合语言/框架的最佳实践
   - 是否遵循设计模式
   - 是否有适当的注释和文档

### 行级评论规则

系统只会在以下情况下对特定代码行提供评论：

1. **严重问题**
   - 明显的bug或逻辑错误
   - 可能导致系统崩溃的代码
   - 严重的安全漏洞

2. **性能问题**
   - 明显的性能瓶颈
   - 不必要的高复杂度操作
   - 资源使用不当

3. **数据一致性问题**
   - 可能导致数据不一致的操作
   - 并发访问问题
   - 事务处理不当

4. **代码规范问题**
   - 严重违反代码规范的情况
   - 可能导致维护困难的结构

> 注意：系统默认采用保守策略，不会对没有明显问题的代码行提供评论，以避免产生过多的噪音。

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
- ```${file.changes.map(c => `${c.lineNumber}: ${c.content} (${c.type === 'add' ? '新增' : '上下文'})`).join('\n')}``` - 变更行的上下文

请确保你的自定义提示返回正确的格式，特别是对于行评论，必须返回有效的JSON数组。

## 部署

### Docker部署

1. 构建Docker镜像

   ```bash
   docker build -t gitea-assistant .
   ```

2. 运行容器

   ```bash
   docker run -d \
     --name gitea-assistant \
     -p 3000:3000 \
     --env-file .env \
     gitea-assistant
   ```

### Kubernetes部署

1. 使用提供的kubernetes.yaml模板

   ```bash
   cp kubernetes.yaml.template kubernetes.yaml
   ```

2. 编辑kubernetes.yaml，更新环境变量和配置

3. 部署到Kubernetes集群

   ```bash
   kubectl apply -f kubernetes.yaml
   ```

## 监控和日志

- 应用日志可以通过Docker或Kubernetes的标准日志收集机制获取
- 建议配置日志聚合服务（如ELK、Grafana Loki等）进行日志管理
- 关键操作（如代码审查、Webhook处理）都会记录详细日志
- 错误和异常会被记录并包含堆栈跟踪信息

## 故障排除

### 常见问题

1. **Webhook验证失败**
   - 检查`WEBHOOK_SECRET`环境变量是否与Gitea配置匹配
   - 确保请求头中的`X-Gitea-Signature`正确传递

2. **OpenAI API调用失败**
   - 验证`OPENAI_API_KEY`是否正确设置
   - 检查网络连接和API端点可访问性
   - 确认API配额是否充足

3. **Gitea API调用失败**
   - 验证`GITEA_ACCESS_TOKEN`是否有效
   - 检查Gitea实例是否可访问
   - 确认令牌权限是否足够

### 调试模式

在开发环境中，可以设置以下环境变量启用调试模式：

```bash
DEBUG=true
NODE_ENV=development
```

## 贡献指南

### 开发流程

1. Fork项目并创建特性分支
2. 提交变更并编写测试
3. 确保代码通过lint检查
4. 提交Pull Request

### 代码规范

- 使用TypeScript编写代码
- 遵循项目中的tslint配置
- 编写清晰的注释和文档
- 保持代码风格一致

### 测试

- 编写单元测试覆盖新功能
- 确保现有测试通过
- 测试Webhook处理逻辑
- 验证AI审查功能

## 版本历史

- v1.0.0: 初始版本发布
  - 基础代码审查功能
  - Webhook集成
  - OpenAI集成
  - 飞书通知支持

## 社区支持

- 提交Issue报告问题
- 参与讨论和功能建议
- 贡献代码和文档
- 分享使用经验
