# Getting Started

## Prerequisites

- Bun >= 1.2.5
- A reachable Gitea instance
- At least one LLM provider credential

## Install

```bash
git clone https://github.com/user/gitea-ai-assistant.git
cd gitea-ai-assistant
bun install
```

`bun install` at repository root installs frontend dependencies via `postinstall`.

If lifecycle scripts are disabled:

```bash
bun run bootstrap
```

## Minimal environment

Create `.env`:

```bash
PORT=5174
ENCRYPTION_KEY= # required, generate with: openssl rand -hex 32
# DATABASE_PATH=./data/assistant.db
```

> `ENCRYPTION_KEY` is required. Application startup fails when it is missing.

## Run

```bash
bun run dev
# or
bun run start
```

## First login

- Open `http://your-server:5174`
- Default admin password is `password` on first boot
- Change admin password immediately after login

## Webhook setup

### Option A: Admin UI (recommended)

In repository list, click enable to auto-provision webhook.

### Option B: Manual

In Gitea repository settings:

- URL: `http://your-server:5174/webhook/gitea`
- Content Type: `application/json`
- Secret: same value as dashboard webhook secret
- Events: Pull Request + Status

## Health endpoint

Use `/api/health` to check service status.
