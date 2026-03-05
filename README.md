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
```

### Configuration

Create a `.env` file with only infrastructure-level settings:

```bash
# Server port (the only required setting)
PORT=3000

# Optional: custom data paths (defaults shown)
# DATABASE_PATH=./data/assistant.db
# MASTER_KEY_PATH=./data/master.key
```

> **All other configuration** (Gitea connection, webhook secret, admin password, review engine, Feishu, memory settings, etc.) is managed through the **Admin Dashboard Web UI** at `http://your-server:3000`. On first boot, all settings are seeded with secure defaults automatically.

See [Configuration Reference](#configuration-reference) for all options.

### Running

```bash
bun run dev    # Development mode
bun run start  # Production mode
```

### Setting Up Webhooks

**Option 1: Admin Dashboard (Recommended)**

1. Access `http://your-server:3000`
2. Log in with the admin password (default: `password` — change it in the dashboard)
3. Click "Enable" on repositories to auto-configure webhooks

**Option 2: Manual Configuration**

In Gitea repository settings, add a webhook:
- **URL**: `http://your-server:3000/webhook/gitea`
- **Content Type**: `application/json`
- **Secret**: Same as the Webhook Secret configured in the dashboard
- **Events**: "Pull Request" and "Status"
## Configuration Reference

### Environment Variables (Minimal)

Only infrastructure-level settings that must be known before the database is initialized:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `5174` |
| `DATABASE_PATH` | SQLite database file path | `./data/assistant.db` |
| `MASTER_KEY_PATH` | Encryption master key file path | `./data/master.key` |

### Web UI Configuration (Admin Dashboard)

All runtime configuration is managed through the **Admin Dashboard** at `http://your-server:PORT`. Changes take effect immediately without restart.

On first boot with an empty database, all settings are seeded with secure defaults:
- `JWT_SECRET` and `WEBHOOK_SECRET` are auto-generated (64-char hex via `crypto.randomBytes`)
- `ADMIN_PASSWORD` defaults to `password` — **change this immediately**

#### Gitea

| Setting | Description |
|---------|-------------|
| Gitea API URL | Gitea API endpoint (e.g. `https://gitea.example.com/api/v1`) |
| Access Token | Token for code review (read + comment permissions) |
| Admin Token | Token for webhook management (optional) |

#### Security

| Setting | Description | Default |
|---------|-------------|---------|
| Webhook Secret | HMAC-SHA256 webhook signature secret | Auto-generated |
| Admin Password | Dashboard login password | `password` |
| JWT Secret | JWT signing secret | Auto-generated |

#### LLM Provider Configuration

LLM providers and models are configured exclusively through the **Admin Dashboard** Web UI:

1. Navigate to **LLM 配置** (LLM Configuration)
2. Add your LLM providers (OpenAI Compatible, OpenAI Responses API, Anthropic, Google Gemini)
3. Assign models to review roles (legacy, planner, specialist, judge, embedding)

> API keys are stored encrypted (AES-256-GCM) in the local SQLite database.

#### Feishu Integration

| Setting | Description |
|---------|-------------|
| Feishu Webhook URL | Feishu bot webhook URL |
| Feishu Webhook Secret | Feishu webhook secret (optional) |

#### Agent Review Engine

| Setting | Description | Default |
|---------|-------------|---------|
| Review Engine | Engine mode (`legacy` or `agent`) | `legacy` |
| Review Work Directory | Working directory for repo clones | `/tmp/gitea-assistant` |
| Max Parallel Runs | Max concurrent review tasks | `2` |
| Max Files per Run | Max files analyzed per review | `200` |
| Auto-publish Min Confidence | Min confidence score for auto-publish | `0.8` |
| Enable Human Gate | Require human approval before publishing | `true` |

#### Memory & Learning (Experimental)

| Setting | Description | Default |
|---------|-------------|---------|
| Qdrant URL | Qdrant vector database URL | - |
| Enable Memory | Enable memory system | `false` |
| Enable Reflection | Enable self-critique | `false` |
| Enable Debate | Enable multi-agent debate | `false` |
## Deployment

### Docker

```bash
docker build -t gitea-assistant .
docker run -d -p 3000:3000 -v ./data:/app/data -e PORT=3000 gitea-assistant
```

### Docker Compose

```bash
docker-compose up -d
```

### Kubernetes

Kubernetes manifests are located in the `k8s/` directory.

**1. Configure**

The only env var in the ConfigMap is `PORT`. All other settings (Gitea connection, webhook secret, admin password, review engine, Feishu, etc.) are configured through the **Admin Dashboard Web UI** after deployment — they are auto-seeded with secure defaults on first boot.

Ensure persistent storage is configured for the `/app/data` directory to retain the SQLite database and encryption key.

**2. Deploy**
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
