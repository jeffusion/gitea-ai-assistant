# Gitea AI Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-powered code review assistant for Gitea. Receives webhooks, runs AI review workflows, and posts summary + line-level feedback back to Gitea.

[English](./docs/README.md) | [中文](./docs/README.zh-CN.md)

## Features

- **Automated PR & commit review** via webhook events
- **Dynamic Agent engine** — main agent autonomously spawns subagents for focused analysis
- **Codex engine** — Codex CLI-backed review as an alternative pipeline
- **Pluggable LLM providers** — OpenAI Compatible, OpenAI Responses API, Anthropic, Gemini
- **Web Admin UI** — runtime configuration for providers, models, webhook, review policy
- **Notifications** — Feishu + WeCom (企业微信)
- **Security-first** — webhook signature verification + AES-256-GCM encrypted API key storage

![Dashboard](./docs/assets/page-repos.png)

## Quick start

```bash
git clone https://github.com/jeffusion/gitea-ai-assistant.git
cd gitea-ai-assistant
bun install                       # installs frontend via postinstall
```

Create `.env`:

```bash
ENCRYPTION_KEY=$(openssl rand -hex 32)
```

```bash
bun run dev
```

Open `http://localhost:5174`, login with default password `password` (change it immediately), then configure Gitea, LLM providers, and webhook in the Admin UI.

See [Getting Started](./docs/getting-started.md) for full setup walkthrough including webhook configuration.

## Documentation

| Topic | Description |
|---|---|
| [Getting Started](./docs/getting-started.md) | Full installation and setup walkthrough |
| [Configuration](./docs/configuration.md) | Environment variables and Admin UI settings |
| [Review Engines](./docs/review-engines.md) | Agent engine, Codex engine, review modes |
| [Deployment](./docs/deployment.md) | Docker, Compose, and Kubernetes |
| [Screenshots](./docs/screenshots.md) | Admin UI gallery |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development conventions and UI guidelines.

## License

MIT
