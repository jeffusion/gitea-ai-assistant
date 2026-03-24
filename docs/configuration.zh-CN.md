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
- 角色模型：planner、specialist、judge、embedding

## 4) 通知

- Feishu Webhook 与可选签名密钥
- WeCom（企业微信）Webhook

## 5) 审查

- 引擎模式：`agent` / `codex`
- Triage 开关
- 规模阈值（`small`/`medium`/`large`）
- 执行模式（`skip`/`light`/`full`）
- Token 预算与并发限制

> 规模与模式是两个层次：
>
> - `small/medium/large`：变更规模分类
> - `skip/light/full`：审查执行深度

## 6) 记忆与学习（可选）

- `ENABLE_MEMORY`（默认 `false`）
- Qdrant URL
- Reflection / Debate 开关

仅在开启记忆能力时需要 Qdrant。
