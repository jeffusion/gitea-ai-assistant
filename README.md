# Gitea AI Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

AI-powered code review assistant for Gitea. Automatically reviews Pull Requests and commits using pluggable LLM providers (OpenAI Compatible, OpenAI Responses API, Anthropic, Google Gemini), providing intelligent code quality analysis with both summary comments and line-level feedback.

**[中文文档](./docs/README.zh-CN.md)**

## Features

- 🤖 **AI Code Review** - Automatic review of PRs and commits using pluggable LLM providers
- 📝 **Line-Level Comments** - Precise feedback on specific code changes
- 🔄 **Task-Based Review Engines** - Agent staged review (skip/light/full) plus optional Codex CLI execution mode
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
| `agent` | Task-based staged review (`skip` / `light` / `full`) with scoped specialist routing and optional reflection/debate escalation | Deep reviews with token-aware execution |
| `codex` | Codex CLI review execution with independent configuration | External Codex-driven review pipeline |

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

> `bun install` at repository root now triggers frontend dependency installation automatically via `postinstall`.
> If your environment skips lifecycle scripts, run `bun run bootstrap` once.

### Configuration

Create a `.env` file with only infrastructure-level settings:

```bash
# Server port
PORT=5174

# REQUIRED: encryption key for API key storage (generate with: openssl rand -hex 32)
ENCRYPTION_KEY=

# Optional: custom database path (default shown)
# DATABASE_PATH=./data/assistant.db
```

> **All other configuration** (Gitea connection, webhook secret, admin password, review engine, Feishu, memory settings, etc.) is managed through the **Admin Dashboard Web UI** at `http://your-server:5174`. On first boot, all settings are seeded with secure defaults automatically.

See [Configuration Reference](#configuration-reference) for all options.

### Running

```bash
bun run dev    # Development mode
bun run start  # Production mode
```

### Setting Up Webhooks

**Option 1: Admin Dashboard (Recommended)**

1. Access `http://your-server:5174`
2. Log in with the admin password (default: `password` — change it in the dashboard)
3. Click "Enable" on repositories to auto-configure webhooks

**Option 2: Manual Configuration**

In Gitea repository settings, add a webhook:
- **URL**: `http://your-server:5174/webhook/gitea`
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
| `ENCRYPTION_KEY` | **Required.** AES-256-GCM encryption key for API key storage (64 hex chars). Generate with `openssl rand -hex 32` | — |

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
3. Assign models to review roles (planner, specialist, judge, embedding)

> API keys are stored encrypted (AES-256-GCM) in the local SQLite database.

#### Feishu Integration

| Setting | Description |
|---------|-------------|
| Feishu Webhook URL | Feishu bot webhook URL |
| Feishu Webhook Secret | Feishu webhook secret (optional) |

#### Agent Review Engine

| Setting | Description | Default |
|---------|-------------|---------|
| Review Engine | Engine mode (`agent` or `codex`) | `agent` |
| Enable Triage | Enable planner triage for task routing | `true` |
| Small Max Files | Upper file-count bound for `small` review size | `3` |
| Small Max Changed Lines | Upper changed-lines bound for `small` review size | `80` |
| Medium Max Files | Upper file-count bound for `medium` review size | `10` |
| Medium Max Changed Lines | Upper changed-lines bound for `medium` review size | `400` |
| Token Budget Small | Token budget cap for `small` staged tasks | `12000` |
| Token Budget Medium | Token budget cap for `medium` staged tasks | `45000` |
| Token Budget Large | Token budget cap for `large` staged tasks | `120000` |
| Review Work Directory | Working directory for repo clones | `/tmp/gitea-assistant` |
| Max Parallel Runs | Max concurrent review tasks | `2` |
| Max Files per Run | Max files analyzed per review | `200` |
| Auto-publish Min Confidence | Min confidence score for auto-publish | `0.8` |
| Enable Human Gate | Require human approval before publishing | `true` |

Agent review execution model (current):

- `skip`: docs/assets/rename-only style changes can bypass specialist review.
- `light`: low-risk code changes run minimal scoped specialist checks.
- `full`: sensitive or larger changes run full specialist tasks, with optional reflection/debate escalation.
- Triage outputs task scopes (`paths`, `riskTags`, `mode`, `tokenBudget`) and orchestrator dispatches specialists by task scope instead of broad fan-out.

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
docker run -d -p 5174:5174 -v ./data:/app/data -e PORT=5174 gitea-assistant
```

### Docker Compose

```bash
docker-compose up -d
```

### Kubernetes

Kubernetes manifests are located in the `k8s/` directory.

**1. Create the encryption secret**

```bash
# Generate a key and create the secret
kubectl apply -f k8s/namespace.yaml
ENCRYPTION_KEY=$(openssl rand -hex 32)
kubectl -n gitea-assistant create secret generic gitea-assistant-secret \
  --from-literal=ENCRYPTION_KEY=$ENCRYPTION_KEY
# Save this key! You'll need it if you ever redeploy.
echo "Your ENCRYPTION_KEY: $ENCRYPTION_KEY"
```

**2. Deploy**

```bash
kubectl apply -k k8s/
```

Or apply individually:

```bash
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
