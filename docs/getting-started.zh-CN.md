# 快速开始

## 环境要求

- [Bun](https://bun.sh) >= 1.2.5
- 可访问的 Gitea 实例
- 至少一个 LLM 提供商凭证（OpenAI、Anthropic、Gemini 或兼容接口）

## 安装

```bash
git clone https://github.com/jeffusion/gitea-ai-assistant.git
cd gitea-ai-assistant
bun install
```

在仓库根目录执行 `bun install` 会通过 `postinstall` 自动安装前端依赖。如果环境禁用了生命周期脚本：

```bash
bun run bootstrap
```

## 配置环境变量

在项目根目录创建 `.env` 文件：

```bash
ENCRYPTION_KEY=<使用 openssl rand -hex 32 生成>
# PORT=5174
# DATABASE_PATH=./data/assistant.db
# LOG_LEVEL=info
```

`ENCRYPTION_KEY` 为必填项——缺失时服务会拒绝启动。它是用于加密数据库中 API Key 的 AES-256-GCM 主密钥。

所有环境变量和运行时设置参见 [配置参考](./configuration.zh-CN.md)。

## 启动服务

```bash
bun run dev          # 开发模式（热重载）
bun run start        # 生产模式
```

访问 `http://localhost:5174` 进入管理后台。

## 首次登录

- 首次启动默认管理员密码为 `password`
- **登录后请立即修改密码**（管理后台「安全」分区）

## 管理后台配置

管理后台管理所有持久化到 SQLite 的运行时配置。`.env` 仅用于基础设施级引导参数。

![管理后台](./assets/page-repos.png)

需要配置的关键项：

1. **Gitea** — API URL、Access Token
2. **LLM Provider** — 添加至少一个提供商（OpenAI Compatible、Anthropic、Gemini 等）并配置 API Key 和默认模型
3. **Webhook Secret** — 用于 HMAC-SHA256 签名验证

完整界面截图参见 [截图集](./screenshots.zh-CN.md)。

## Webhook 配置

### 方式 A：管理后台（推荐）

在仓库列表页点击启用按钮，系统自动在 Gitea 中配置 Webhook。

### 方式 B：手动配置

在 Gitea 仓库设置 → Webhooks → 添加 Webhook：

| 字段 | 值 |
|---|---|
| URL | `http://your-server:5174/webhook/gitea` |
| Content Type | `application/json` |
| Secret | 与管理后台中配置的 Webhook Secret 保持一致 |
| 事件 | Pull Request + Status |

## 健康检查

```
GET /api/health
```

## 下一步

- [配置参考](./configuration.zh-CN.md) — 完整设置项与运行时模型
- [审查引擎](./review-engines.zh-CN.md) — Agent 引擎、Codex 引擎与审查模式
- [部署指南](./deployment.zh-CN.md) — Docker、Compose、Kubernetes
