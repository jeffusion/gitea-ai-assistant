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
- Role mapping: planner, specialist, judge, embedding

## 4) Notification

- Feishu webhook and optional secret
- WeCom (企业微信) webhook

## 5) Review

- Engine mode: `agent` or `codex`
- Triage switch
- Size thresholds (`small`/`medium`/`large`)
- Execution modes (`skip`/`light`/`full`)
- Token budgets and concurrency limits

> Size and mode are different layers:
>
> - `small/medium/large`: change-size classification
> - `skip/light/full`: review execution depth

## 6) Memory & learning (optional)

- `ENABLE_MEMORY` (default `false`)
- Qdrant URL
- Reflection/debate toggles

Qdrant is only required when memory is enabled.
