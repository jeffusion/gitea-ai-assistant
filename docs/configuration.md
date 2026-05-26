# Configuration Reference

## Configuration model

This project uses a DB-first runtime configuration model:

- `.env` contains only infrastructure-level bootstrap values.
- Runtime settings (Gitea, providers, secrets, review policy, notifications) are managed in Admin UI and stored in SQLite.

## Environment variables (minimal)

| Variable | Required | Description | Default |
|---|---|---|---|
| `ENCRYPTION_KEY` | Yes | AES-256-GCM master key (64 hex chars) for API key encryption | - |
| `PORT` | No | Service port | `5174` |
| `DATABASE_PATH` | No | SQLite path | `./data/assistant.db` |
| `LOG_LEVEL` | No | Backend log level (`debug`/`info`/`warn`/`error`). Default is `info`; use `error` in production. | `info` |

Generate key:

```bash
openssl rand -hex 32
```

## First boot defaults

When database is empty:

- `JWT_SECRET` auto-generated
- `WEBHOOK_SECRET` auto-generated
- `ADMIN_PASSWORD` defaults to `password`

Change `ADMIN_PASSWORD` immediately after first login.

## Runtime groups in Admin UI

## 1) Gitea

- API URL
- Access token
- Admin token (optional)

## 2) Security

- Webhook secret (HMAC-SHA256 verification)
- Admin password
- JWT secret

## 3) LLM

- Providers: OpenAI Compatible / OpenAI Responses / Anthropic / Gemini
- Agent runtime models:
  - `AGENT_MAIN_MODEL`: The main model name used by the agent runtime when no specific model is configured. Default is `gpt-4.1`.
  - `AGENT_DEFAULT_SUBAGENT_MODEL`: The default model name used by subagents when no specific model is declared in their definition or overridden during spawn. Default is `gpt-4.1-mini`.

## 4) Notification

- Feishu webhook and optional secret
- WeCom (企业微信) webhook

## 5) Review

- Engine mode: `agent` or `codex`
- Triage size classification and routing hints
- Size thresholds (`small`/`medium`/`large`)
- Execution modes (`skip`/`light`/`full`)
- Token budgets and concurrency limits

> Size and mode are different layers:
>
> - `small/medium/large`: change-size classification
> - `skip/light/full`: review execution depth

## Agent Definitions

Project agent definitions are stored as Markdown files with frontmatter in the repository:
- Path: `.gitea-assistant/agents/*.md`

These files define the system prompts, metadata, and execution parameters for each agent.

## Tool Permissions

Tool permissions are controlled directly within each agent's definition file:
- `tools`: An allow-list of tool names that the agent is permitted to call. An empty list grants no tools.
- `disallowedTools`: A deny-list of tool names that the agent is explicitly forbidden from calling. This takes precedence over the allow-list.
