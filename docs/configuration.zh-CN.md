# 配置参考

## 配置模型

项目采用 **DB-first** 运行时配置模型：

- `.env` 仅存储基础设施级引导参数
- 运行时配置（Gitea、Provider、密钥、审查策略、通知）由管理后台维护并持久化到 SQLite

即大部分设置在首次启动后通过 Web 管理后台配置，而非环境变量。

## 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `ENCRYPTION_KEY` | 是 | API Key 加密主密钥（AES-256-GCM，64 位十六进制） | — |
| `PORT` | 否 | 服务端口 | `5174` |
| `DATABASE_PATH` | 否 | SQLite 数据库路径 | `./data/assistant.db` |
| `LOG_LEVEL` | 否 | 后端日志级别：`debug` / `info` / `warn` / `error` | `info` |

生成加密密钥：

```bash
openssl rand -hex 32
```

## 首次启动默认值

数据库为空时首次启动：

- `JWT_SECRET` — 自动生成
- `WEBHOOK_SECRET` — 自动生成
- `ADMIN_PASSWORD` — 默认 `password`（**登录后请立即修改**）

## 管理后台设置

以下所有设置均通过管理后台 `http://your-server:5174` 配置。

### Gitea

| 设置项 | 说明 |
|---|---|
| API URL | Gitea API 端点（如 `http://gitea:3000/api/v1`） |
| Access Token | 用于克隆仓库和发布评论的令牌 |
| Admin Token | 可选；仓库发现功能需要 |

### 安全

| 设置项 | 说明 |
|---|---|
| Webhook Secret | HMAC-SHA256 签名验证密钥 |
| Admin Password | 管理后台登录密码 |
| JWT Secret | Token 签名密钥（首次启动自动生成） |

### LLM

| 设置项 | 说明 |
|---|---|
| Provider | 添加一个或多个提供商：OpenAI Compatible / OpenAI Responses / Anthropic / Gemini |
| `AGENT_MAIN_MODEL` | 主 Agent 运行时默认模型。默认值：`gpt-4.1` |
| `AGENT_DEFAULT_SUBAGENT_MODEL` | 子 Agent 未声明模型且 spawn 未覆盖时的默认模型。默认值：`gpt-4.1-mini` |

模型解析顺序：`spawn 覆盖 > AgentDefinition.model > AGENT_DEFAULT_SUBAGENT_MODEL > AGENT_MAIN_MODEL`

### 通知

| 设置项 | 说明 |
|---|---|
| Feishu Webhook | 飞书机器人 Webhook URL 及可选签名密钥 |
| WeCom Webhook | 企业微信机器人 Webhook URL |

### 审查

| 设置项 | 说明 |
|---|---|
| 引擎 | `agent` 或 `codex` |
| 规模阈值 | `small` / `medium` / `large` — 变更规模分类 |
| 执行模式 | `skip` / `light` / `full` — 审查深度控制 |
| Token 预算 | 各模式 Token 限额 |
| 并发限制 | 最大并行审查数 |

> 规模与模式是两个层次：`small/medium/large` 分类变更的大小；`skip/light/full` 控制审查的深度。
