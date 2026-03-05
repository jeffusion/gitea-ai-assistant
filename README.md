# Gitea AI Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-powered code review assistant for Gitea. Automatically reviews Pull Requests and commits using pluggable LLM providers (OpenAI Compatible, OpenAI Responses API, Anthropic, Google Gemini), providing intelligent code quality analysis with both summary comments and line-level feedback.

**[中文文档](./docs/README.zh-CN.md)**

## Features

- 🤖 **AI Code Review** - Automatic review of PRs and commits using pluggable LLM providers
- 📝 **Line-Level Comments** - Precise feedback on specific code changes
- 🔄 **Dual Review Engines** - Legacy (simple) or Agent-based (multi-agent) review modes
- 🔔 **Feishu Notifications** - Integrated notification system for PR events
- 🎛️ **Admin Dashboard** - Web UI for managing repository webhooks and LLM provider configuration
- 🔐 **Secure Webhooks** - HMAC-SHA256 signature verification

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Gitea Server  │────▶│ Gitea Assistant  │────▶│   LLM Gateway   │
│   (Webhooks)    │     │  (Hono + Bun)    │     │  (Multi-Provider)│
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                        │
                               ▼                        ├─ OpenAI Compatible
                        ┌──────────────────┐            ├─ OpenAI Responses API
                        │  Admin Dashboard │            ├─ Anthropic
                        │   (React SPA)    │            └─ Google Gemini
                        └──────────────────┘
```

### Review Engines

| Engine | Description | Use Case |
|--------|-------------|----------|
| `legacy` | Single-pass AI review with summary + line comments | Simple, fast reviews |
| `agent` | Multi-agent orchestration with specialists, reflection, and debate | Deep, comprehensive analysis |

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.2.5
- Gitea instance with API access
- At least one LLM provider API key (OpenAI, Anthropic, Google Gemini, or any OpenAI-compatible endpoint)

### Installation

```bash
git clone https://github.com/user/gitea-ai-assistant.git
cd gitea-ai-assistant
bun install
cp .env.example .env
```

### Configuration

Edit `.env` with your settings:

```bash
# Gitea
GITEA_API_URL=https://your-gitea-instance.com/api/v1
GITEA_ACCESS_TOKEN=your_gitea_token

# Security
WEBHOOK_SECRET=your_webhook_secret  # openssl rand -hex 32

# Admin Dashboard
ADMIN_PASSWORD=your_admin_password
```

> **Note**: LLM provider settings (API keys, models, endpoints) are configured through the Admin Dashboard Web UI, not environment variables. Access the dashboard at `http://your-server:3000` after starting the server.

See [Configuration Reference](#configuration-reference) for all options.

### Running

```bash
bun run dev    # Development mode
bun run start  # Production mode
```

### Setting Up Webhooks

**Option 1: Admin Dashboard (Recommended)**

1. Access `http://your-server:3000`
2. Log in with `ADMIN_PASSWORD`
3. Click "Enable" on repositories to auto-configure webhooks

**Option 2: Manual Configuration**

In Gitea repository settings, add a webhook:
- **URL**: `http://your-server:3000/webhook/gitea`
- **Content Type**: `application/json`
- **Secret**: Same as `WEBHOOK_SECRET`
- **Events**: "Pull Request" and "Status"

## Configuration Reference

### Core Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `GITEA_API_URL` | Gitea API endpoint | Required |
| `GITEA_ACCESS_TOKEN` | Token for code review (read + comment permissions) | Required |
| `GITEA_ADMIN_TOKEN` | Token for webhook management (optional) | - |
| `PORT` | Server port | `3000` |
| `WEBHOOK_SECRET` | Webhook signature secret | Required |

### LLM Provider Configuration

LLM providers and models are configured exclusively through the **Admin Dashboard** Web UI:

1. Access the dashboard at `http://your-server:3000`
2. Navigate to **LLM 配置** (LLM Configuration)
3. Add your LLM providers (OpenAI Compatible, OpenAI Responses API, Anthropic, Google Gemini)
4. Assign models to review roles (legacy, planner, specialist, judge, embedding)

> API keys are stored encrypted (AES-256-GCM) in a local SQLite database.
### Custom Prompts

| Variable | Description |
|----------|-------------|
| `CUSTOM_SUMMARY_PROMPT` | Override the default summary review prompt |
| `CUSTOM_LINE_COMMENT_PROMPT` | Override the default line comment prompt |

### Admin Dashboard

| Variable | Description | Default |
|----------|-------------|---------|
| `ADMIN_PASSWORD` | Dashboard login password | `password` |
| `JWT_SECRET` | JWT signing secret | Auto-generated |

### Feishu Integration

| Variable | Description |
|----------|-------------|
| `FEISHU_WEBHOOK_URL` | Feishu bot webhook URL |
| `FEISHU_WEBHOOK_SECRET` | Feishu webhook secret (optional) |

### Agent Review Engine

Enable with `REVIEW_ENGINE=agent` for advanced multi-agent reviews:

| Variable | Description | Default |
|----------|-------------|---------|
| `REVIEW_ENGINE` | Engine mode (`legacy` or `agent`) | `legacy` |
| `REVIEW_WORKDIR` | Working directory for repo clones | `/tmp/gitea-assistant` |
| `REVIEW_MAX_PARALLEL_RUNS` | Max concurrent tasks | `2` |
| `REVIEW_MAX_FILES_PER_RUN` | Max files per review | `200` |
| `REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE` | Min confidence for auto-publish | `0.8` |
| `REVIEW_ENABLE_HUMAN_GATE` | Enable human approval | `true` |
### Memory & Learning (Experimental)

| Variable | Description | Default |
|----------|-------------|---------|
| `QDRANT_URL` | Qdrant vector database URL | - |
| `ENABLE_MEMORY` | Enable memory system | `false` |
| `ENABLE_REFLECTION` | Enable self-critique | `false` |
| `ENABLE_DEBATE` | Enable multi-agent debate | `false` |

## Deployment

### Docker

```bash
docker build -t gitea-assistant .
docker run -d -p 3000:3000 --env-file .env gitea-assistant
```

### Docker Compose

```bash
docker-compose up -d
```

### Kubernetes

Kubernetes manifests are located in the `k8s/` directory.

**1. Configure Secrets**

Encode your credentials as base64 and update `k8s/gitea-assistant.yaml`:

```bash
echo -n "your_gitea_token" | base64
echo -n "your_webhook_secret" | base64
echo -n "your_admin_password" | base64
```

**2. Configure Application**

Edit the ConfigMap in `k8s/gitea-assistant.yaml`:

- Set `GITEA_API_URL` to your Gitea instance API endpoint
- Adjust review engine settings as needed

> **Note**: LLM provider configuration is done through the Admin Dashboard after deployment. Ensure persistent storage is configured for the `/app/data` directory to retain LLM settings and encrypted API keys.
**3. Deploy**

```bash
# Using Kustomize (recommended)
kubectl apply -k k8s/

# Or apply individually
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/qdrant.yaml
kubectl apply -f k8s/gitea-assistant.yaml
```

**4. Verify**

```bash
kubectl -n gitea-assistant get pods
kubectl -n gitea-assistant get svc
```

**5. Expose the Service (optional)**

By default, services use `ClusterIP`. To expose externally, use an Ingress or change the Service type:

```bash
kubectl -n gitea-assistant patch svc gitea-assistant -p '{"spec":{"type":"NodePort"}}'
```

## License

MIT License
