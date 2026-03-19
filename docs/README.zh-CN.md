# Gitea AI Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

基于 AI 的 Gitea 代码审查助手。自动审查 Pull Request 和提交，支持多种 LLM 提供商（OpenAI 兼容、OpenAI Responses API、Anthropic、Google Gemini），提供智能代码质量分析，支持总体评论和行级反馈。

**[English Documentation](../README.md)**

## 功能特点

- 🤖 **AI 代码审查** - 使用可插拔的 LLM 提供商自动审查 PR 和提交
- 📝 **行级评论** - 针对具体代码变更的精确反馈
- 🔄 **任务化审查引擎** - Agent 分级审查（skip/light/full）+ 可选 Codex CLI 审查模式
- 🔔 **飞书通知** - PR 事件通知集成
- 🎛️ **管理后台** - 用于管理仓库 Webhook 和 LLM 提供商配置的 Web 界面
- 🔐 **安全验证** - HMAC-SHA256 签名验证

## 架构设计

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Gitea 服务器   │────▶│  Gitea Assistant │────▶│   LLM 网关      │
│   (Webhooks)    │     │  (Hono + Bun)    │     │  (多提供商)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                        │
                               ▼                        ├─ OpenAI 兼容
                        ┌──────────────────┐            ├─ OpenAI Responses API
                        │    管理后台       │            ├─ Anthropic
                        │   (React SPA)    │            └─ Google Gemini
                        └──────────────────┘
```

### 审查引擎对比

| 引擎 | 描述 | 适用场景 |
|------|------|----------|
| `agent` | 任务化分级审查（`skip` / `light` / `full`），按路径范围派发 specialist，并按需升级到反思/辩论 | 在控制 token 成本的前提下做深度审查 |
| `codex` | 通过 Codex CLI 执行审查，独立配置 | 对接外部 Codex 审查流程 |

## 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.2.5
- 可访问的 Gitea 实例
- 至少一个 LLM 提供商的 API 密钥（OpenAI、Anthropic、Google Gemini 或任何 OpenAI 兼容端点）

### 安装步骤

```bash
git clone https://github.com/user/gitea-ai-assistant.git
cd gitea-ai-assistant
bun install
```

### 配置说明

创建 `.env` 文件，仅填写基础设施级别的配置：

```bash
# 服务端口
PORT=3000

# 必填：API Key 加密存储密钥（运行 openssl rand -hex 32 生成）
ENCRYPTION_KEY=

# 可选：自定义数据库路径（以下为默认值）
# DATABASE_PATH=./data/assistant.db
```

> **所有其他配置**（Gitea 连接、Webhook 密钥、管理员密码、审查引擎、飞书、记忆系统等）均通过 **Web 管理后台** 在 `http://your-server:3000` 进行配置。首次启动时，所有设置会自动以安全的默认值进行初始化。

完整配置项请参阅 [配置参考](#配置参考)。

### 启动服务

```bash
bun run dev    # 开发模式
bun run start  # 生产模式
```

### 配置 Webhook

**方式一：管理后台（推荐）**

1. 在浏览器中访问 `http://your-server:3000`
2. 使用管理员密码登录（默认：`password`，请在后台及时修改）
3. 点击仓库对应的「启用」按钮自动配置 Webhook

**方式二：手动配置**

在 Gitea 仓库设置中添加 Webhook：
- **URL**: `http://your-server:3000/webhook/gitea`
- **内容类型**: `application/json`
- **密钥**: 与管理后台中配置的 Webhook 密钥相同
- **触发事件**: 「Pull Request」和「Status」
## 配置参考

### 环境变量（最小化）

仅包含数据库初始化前必须已知的基础设施级别配置：

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `5174` |
| `DATABASE_PATH` | SQLite 数据库文件路径 | `./data/assistant.db` |
| `ENCRYPTION_KEY` | **必填。** AES-256-GCM 加密密钥，用于加密存储 API Key（64 位十六进制字符串）。运行 `openssl rand -hex 32` 生成 | — |

### Web 界面配置（管理后台）

所有运行时配置均通过 **管理后台** `http://your-server:PORT` 进行管理，修改后立即生效，无需重启。

首次以空数据库启动时，所有设置会自动以安全默认值初始化：
- `JWT_SECRET` 和 `WEBHOOK_SECRET` 自动生成（通过 `crypto.randomBytes` 生成 64 位十六进制字符串）
- `ADMIN_PASSWORD` 默认为 `password`，**请立即修改**

#### Gitea

| 配置项 | 描述 |
|--------|------|
| Gitea API 地址 | Gitea API 端点（如 `https://gitea.example.com/api/v1`） |
| 访问令牌 | 代码审查令牌（需读取和评论权限） |
| 管理员令牌 | Webhook 管理令牌（可选） |

#### 安全

| 配置项 | 描述 | 默认值 |
|--------|------|--------|
| Webhook 密钥 | HMAC-SHA256 Webhook 签名密钥 | 自动生成 |
| 管理员密码 | 后台登录密码 | `password` |
| JWT 密钥 | JWT 签名密钥 | 自动生成 |

#### LLM 提供商配置

LLM 提供商和模型通过**管理后台** Web 界面进行配置：

1. 导航到 **LLM 配置** 页面
2. 添加 LLM 提供商（OpenAI 兼容、OpenAI Responses API、Anthropic、Google Gemini）
3. 为审查角色分配模型（planner、specialist、judge、embedding）

> API 密钥使用 AES-256-GCM 加密存储在本地 SQLite 数据库中。

#### 飞书集成

| 配置项 | 描述 |
|--------|------|
| 飞书 Webhook 地址 | 飞书机器人 Webhook URL |
| 飞书 Webhook 密钥 | 飞书 Webhook 密钥（可选） |

#### Agent 审查引擎

| 配置项 | 描述 | 默认值 |
|--------|------|--------|
| 审查引擎 | 引擎模式（`agent` 或 `codex`） | `agent` |
| 启用分流（Enable Triage） | 启用 planner 分流并输出任务化审查计划 | `true` |
| Small 文件上限 | 判定 `small` 规模审查的文件数上限 | `3` |
| Small 变更行上限 | 判定 `small` 规模审查的变更行数上限 | `80` |
| Medium 文件上限 | 判定 `medium` 规模审查的文件数上限 | `10` |
| Medium 变更行上限 | 判定 `medium` 规模审查的变更行数上限 | `400` |
| Small Token 预算 | `small` 任务的 token 预算上限 | `12000` |
| Medium Token 预算 | `medium` 任务的 token 预算上限 | `45000` |
| Large Token 预算 | `large` 任务的 token 预算上限 | `120000` |
| 工作目录 | 仓库克隆工作目录 | `/tmp/gitea-assistant` |
| 最大并发数 | 最大并发审查任务数 | `2` |
| 最大文件数 | 单次审查最大文件数 | `200` |
| 自动发布置信度 | 自动发布最小置信度 | `0.8` |
| 启用人工审批 | 发布前要求人工确认 | `true` |

当前 Agent 审查执行模型：

- `skip`：文档/资源/纯重命名等低风险改动可直接跳过 specialist。
- `light`：低风险代码改动执行最小化、按路径范围限定的 specialist 审查。
- `full`：敏感路径或中大型改动执行完整任务审查，并可按配置升级到 reflection/debate。
- Triage 输出任务（`paths`、`riskTags`、`mode`、`tokenBudget`），Orchestrator 按任务范围派发，不再默认全量扇出。

#### 记忆与学习（实验性）

| 配置项 | 描述 | 默认值 |
|--------|------|--------|
| Qdrant 地址 | Qdrant 向量数据库地址 | - |
| 启用记忆 | 启用记忆系统 | `false` |
| 启用反思 | 启用自我批评 | `false` |
| 启用辩论 | 启用多代理辩论 | `false` |
## 部署指南

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

Kubernetes 部署清单位于 `k8s/` 目录。

**1. 创建加密密钥**

```bash
# 生成密钥并创建 Secret
kubectl apply -f k8s/namespace.yaml
ENCRYPTION_KEY=$(openssl rand -hex 32)
kubectl -n gitea-assistant create secret generic gitea-assistant-secret \
  --from-literal=ENCRYPTION_KEY=$ENCRYPTION_KEY
# 请保存此密钥！重新部署时需要使用。
echo "你的 ENCRYPTION_KEY: $ENCRYPTION_KEY"
```

**2. 部署**

```bash
kubectl apply -k k8s/
```

或逐个应用：

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/qdrant.yaml
kubectl apply -f k8s/gitea-assistant.yaml
```

**4. 验证**

```bash
kubectl -n gitea-assistant get pods
kubectl -n gitea-assistant get svc
```

**5. 暴露服务（可选）**

默认使用 `ClusterIP` 类型。如需外部访问，可使用 Ingress 或修改 Service 类型：

```bash
kubectl -n gitea-assistant patch svc gitea-assistant -p '{"spec":{"type":"NodePort"}}'
```

## 许可证

MIT 许可证
