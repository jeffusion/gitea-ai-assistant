# Gitea AI Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-powered code review assistant for Gitea. It receives webhooks, runs staged AI review workflows, and posts summary + line-level feedback back to Gitea.

- English docs: [./docs/README.md](./docs/README.md)
- 中文文档: [./docs/README.zh-CN.md](./docs/README.zh-CN.md)

## Why this project

- 🤖 **Automated PR + commit review** via webhook events (`pull_request`, `status`)
- 🧠 **Two review engines**: `agent` (staged tasks) and `codex` (Codex CLI pipeline)
- 🧵 **Pluggable LLM providers**: OpenAI Compatible, OpenAI Responses API, Anthropic, Gemini
- 📍 **Actionable output**: summary comments and line-level findings
- 🎛️ **Web Admin UI** for runtime configuration (providers, models, webhook, review policy)
- 🔔 **Notifications**: Feishu + WeCom (企业微信)
- 🔐 **Security-first defaults**: webhook signature verification + encrypted API key storage

## Product screenshot

> Dashboard screenshot is generated from local dev service.

![Gitea AI Assistant Dashboard - Repository Page](./docs/assets/page-repos.png)

More screenshots (one per admin menu): [EN](./docs/screenshots.md) | [中文](./docs/screenshots.zh-CN.md)

## Architecture (high-level)

```
Gitea Webhook -> Gitea AI Assistant (Hono + Bun) -> LLM Gateway (multi-provider)
                                 |
                                 +-> Admin Dashboard (React)
```

For component-level design, see [Architecture docs](./docs/README.md#architecture--design).

## Quick start (minimal)

### 1) Prerequisites

- Bun >= 1.2.5
- Reachable Gitea instance
- At least one LLM provider credential

### 2) Install

```bash
git clone https://github.com/user/gitea-ai-assistant.git
cd gitea-ai-assistant
bun install
```

If lifecycle scripts are disabled in your environment, run:

```bash
bun run bootstrap
```

### 3) Minimal `.env`

```bash
PORT=5174
ENCRYPTION_KEY=   # required, 64 hex chars (openssl rand -hex 32)
# DATABASE_PATH=./data/assistant.db
```

> `ENCRYPTION_KEY` is mandatory. The app refuses to start without it.

### 4) Run

```bash
bun run dev
# or
bun run start
```

### 5) Configure in Admin UI

Open `http://your-server:5174`, login with default `password` (first boot only), then change it immediately.

- Configure Gitea API + tokens
- Configure webhook secret
- Configure LLM providers/models
- Configure review engine and policy

### 6) Add webhook in Gitea

- URL: `http://your-server:5174/webhook/gitea`
- Content-Type: `application/json`
- Secret: same as dashboard webhook secret
- Events: Pull Request + Status

## Progressive disclosure: detailed docs

- [Documentation index](./docs/README.md)
- [Getting started details](./docs/getting-started.md)
- [Configuration reference](./docs/configuration.md)
- [Review engines](./docs/review-engines.md)
- [Deployment (Docker / Compose / Kubernetes)](./docs/deployment.md)

## License

MIT License
