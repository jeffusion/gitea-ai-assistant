# 配置参考

## 配置模型

项目采用 DB-first 运行时配置模型：

- `.env` 仅用于基础设施级引导参数
- 运行时配置（Gitea、Provider、密钥、审查策略、通知）由管理后台维护并持久化到 SQLite

## 环境变量（最小集）

| 变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `ENCRYPTION_KEY` | 是 | API Key 加密主密钥（AES-256-GCM，64 位十六进制） | - |
| `PORT` | 否 | 服务端口 | `5174` |
| `DATABASE_PATH` | 否 | SQLite 路径 | `./data/assistant.db` |
| `LOG_LEVEL` | 否 | 后端日志级别（`debug`/`info`/`warn`/`error`）。默认 `info`；生产环境建议 `error`。 | `info` |

生成密钥：

```bash
openssl rand -hex 32
```

## 首次启动默认值

当数据库为空时：

- `JWT_SECRET` 自动生成
- `WEBHOOK_SECRET` 自动生成
- `ADMIN_PASSWORD` 默认 `password`

首次登录后请立即修改管理员密码。

## 管理后台配置分组

## 1) Gitea

- API URL
- Access Token
- Admin Token（可选）

## 2) 安全

- Webhook Secret（HMAC-SHA256 验签）
- Admin Password
- JWT Secret

## 3) LLM

- Provider：OpenAI Compatible / OpenAI Responses / Anthropic / Gemini
- Agent 运行时模型：
  - `AGENT_MAIN_MODEL`：在没有更具体模型配置时，Agent 运行时使用的主模型名称。默认值为 `gpt-4.1`。
  - `AGENT_DEFAULT_SUBAGENT_MODEL`：当子代理（Subagent）未声明模型且 spawn 未覆盖时，使用的默认模型名称。默认值为 `gpt-4.1-mini`。

## 4) 通知

- Feishu Webhook 与可选签名密钥
- WeCom（企业微信）Webhook

## 5) 审查

- 引擎模式：`agent` / `codex`
- Triage 规模分类与路由提示
- 规模阈值（`small`/`medium`/`large`）
- 执行模式（`skip`/`light`/`full`）
- Token 预算与并发限制

> 规模与模式是两个层次：
>
> - `small/medium/large`：变更规模分类
> - `skip/light/full`：审查执行深度

## Agent 定义

项目的 Agent 定义以带有 Frontmatter 的 Markdown 文件形式存储在仓库中：
- 路径：`.gitea-assistant/agents/*.md`

这些文件定义了每个 Agent 的系统提示词、元数据和执行参数。

## 工具权限

工具权限直接在每个 Agent 的定义文件中进行控制：
- `tools`：允许该 Agent 调用的工具名称白名单。如果列表为空，则不授予任何工具权限。
- `disallowedTools`：显式禁止该 Agent 调用的工具名称黑名单。黑名单的优先级高于白名单。
