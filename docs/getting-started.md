# Getting Started

## Prerequisites

- [Bun](https://bun.sh) >= 1.2.5
- A reachable Gitea instance
- At least one LLM provider credential (OpenAI, Anthropic, Gemini, or compatible)

## Install

```bash
git clone https://github.com/jeffusion/gitea-ai-assistant.git
cd gitea-ai-assistant
bun install
```

`bun install` at repository root installs frontend dependencies via `postinstall`. If lifecycle scripts are disabled:

```bash
bun run bootstrap
```

## Configure environment

Create `.env` in the project root:

```bash
ENCRYPTION_KEY=<generate with: openssl rand -hex 32>
# PORT=5174
# DATABASE_PATH=./data/assistant.db
# LOG_LEVEL=info
```

`ENCRYPTION_KEY` is required — the application refuses to start without it. It is the AES-256-GCM master key for encrypting API keys stored in the database.

See [Configuration](./configuration.md) for all environment variables and runtime settings.

## Run

```bash
bun run dev          # development with hot reload
bun run start        # production mode
```

Open `http://localhost:5174` to access the Admin UI.

## First login

- Default admin password is `password` on first boot.
- **Change it immediately** after login (Security section in Admin UI).

## Configure in Admin UI

The Admin UI manages all runtime settings stored in SQLite. You only need `.env` for infrastructure bootstrap values.

![Dashboard](./assets/page-repos.png)

Key settings to configure:

1. **Gitea** — API URL, access token
2. **LLM Providers** — add at least one provider (OpenAI Compatible, Anthropic, Gemini, etc.) with API key and default model
3. **Webhook Secret** — used for HMAC-SHA256 signature verification

See [Screenshots](./screenshots.md) for a full UI gallery.

## Webhook setup

### Option A: Admin UI (recommended)

In the repository list page, click the enable button. The system auto-provisions the webhook in Gitea.

### Option B: Manual

In Gitea repository settings → Webhooks → Add webhook:

| Field | Value |
|---|---|
| URL | `http://your-server:5174/webhook/gitea` |
| Content Type | `application/json` |
| Secret | Same value as configured in Admin UI |
| Events | Pull Request + Status |

## Health check

```
GET /api/health
```

## Next steps

- [Configuration reference](./configuration.md) — all settings and runtime model
- [Review engines](./review-engines.md) — Agent engine, Codex engine, review modes
- [Deployment](./deployment.md) — Docker, Compose, Kubernetes
