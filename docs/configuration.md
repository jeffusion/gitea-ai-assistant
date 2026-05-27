# Configuration Reference

## Configuration model

This project uses a **DB-first** runtime configuration model:

- `.env` stores only infrastructure-level bootstrap values
- Runtime settings (Gitea, providers, secrets, review policy, notifications) are managed in Admin UI and persisted to SQLite

This means you configure most settings through the web dashboard after first boot, not through environment variables.

## Environment variables

| Variable | Required | Description | Default |
|---|---|---|---|
| `ENCRYPTION_KEY` | Yes | AES-256-GCM master key for API key encryption (64 hex chars) | — |
| `PORT` | No | Service port | `5174` |
| `DATABASE_PATH` | No | SQLite database path | `./data/assistant.db` |
| `LOG_LEVEL` | No | Backend log level: `debug` / `info` / `warn` / `error` | `info` |

Generate encryption key:

```bash
openssl rand -hex 32
```

## First boot defaults

When the database is empty on first launch:

- `JWT_SECRET` — auto-generated
- `WEBHOOK_SECRET` — auto-generated
- `ADMIN_PASSWORD` — defaults to `password` (**change immediately after login**)

## Admin UI settings

All settings below are configured through the Admin UI at `http://your-server:5174`.

### Gitea

| Setting | Description |
|---|---|
| API URL | Gitea API endpoint (e.g. `http://gitea:3000/api/v1`) |
| Access Token | Token for cloning repos and posting comments |
| Admin Token | Optional; required for repository discovery |

### Security

| Setting | Description |
|---|---|
| Webhook Secret | HMAC-SHA256 key for verifying incoming webhooks |
| Admin Password | Dashboard login password |
| JWT Secret | Token signing key (auto-generated on first boot) |

### LLM

| Setting | Description |
|---|---|
| Providers | Add one or more providers: OpenAI Compatible / OpenAI Responses / Anthropic / Gemini |
| `AGENT_MAIN_MODEL` | Default model for the main agent runtime. Default: `gpt-4.1` |
| `AGENT_DEFAULT_SUBAGENT_MODEL` | Default model for subagents when not declared in definition or spawn. Default: `gpt-4.1-mini` |

Model resolution order: `spawn override > AgentDefinition.model > AGENT_DEFAULT_SUBAGENT_MODEL > AGENT_MAIN_MODEL`

### Notifications

| Setting | Description |
|---|---|
| Feishu Webhook | Feishu bot webhook URL and optional signing secret |
| WeCom Webhook | WeCom (企业微信) bot webhook URL |

### Review

| Setting | Description |
|---|---|
| Engine | `agent` or `codex` |
| Size thresholds | `small` / `medium` / `large` — classifies change size |
| Execution modes | `skip` / `light` / `full` — controls review depth |
| Token budgets | Per-mode token limits |
| Concurrency | Max parallel review runs |

> Size and mode are separate layers: `small/medium/large` classifies how big the change is; `skip/light/full` controls how deeply the engine reviews it.
