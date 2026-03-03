# Gitea AI Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

基于 AI 的 Gitea 代码审查助手。自动审查 Pull Request 和提交，使用 OpenAI 提供智能代码质量分析，支持总体评论和行级反馈。

**[English Documentation](../README.md)**

## 功能特点

- 🤖 **AI 代码审查** - 使用 OpenAI 模型自动审查 PR 和提交
- 📝 **行级评论** - 针对具体代码变更的精确反馈
- 🔄 **双引擎模式** - Legacy（简单）或 Agent（多代理）审查模式
- 🔔 **飞书通知** - PR 事件通知集成
- 🎛️ **管理后台** - 用于管理仓库 Webhook 和配置的 Web 界面
- 🔐 **安全验证** - HMAC-SHA256 签名验证

## 架构设计

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Gitea 服务器   │────▶│  Gitea Assistant │────▶│   OpenAI API    │
│   (Webhooks)    │     │  (Hono + Bun)    │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │    管理后台       │
                        │   (React SPA)    │
                        └──────────────────┘
```

### 审查引擎对比

| 引擎 | 描述 | 适用场景 |
|------|------|----------|
| `legacy` | 单次 AI 审查，生成总结和行级评论 | 简单、快速的审查 |
| `agent` | 多代理编排，支持专家、反思和辩论 | 深度、全面的分析 |

## 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.2.5
- 可访问的 Gitea 实例
- OpenAI API 密钥

### 安装步骤

```bash
git clone https://github.com/user/gitea-ai-assistant.git
cd gitea-ai-assistant
bun install
cp .env.example .env
```

### 配置说明

编辑 `.env` 文件：

```bash
# Gitea
GITEA_API_URL=https://your-gitea-instance.com/api/v1
GITEA_ACCESS_TOKEN=your_gitea_token

# OpenAI
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-4o-mini

# 安全
WEBHOOK_SECRET=your_webhook_secret  # openssl rand -hex 32

# 管理后台
ADMIN_PASSWORD=your_admin_password
```

完整配置项请参阅 [配置参考](#配置参考)。

### 启动服务

```bash
bun run dev    # 开发模式
bun run start  # 生产模式
```

### 配置 Webhook

**方式一：管理后台（推荐）**

1. 在浏览器中访问 `http://your-server:3000`
2. 使用 `ADMIN_PASSWORD` 登录
3. 点击仓库对应的「启用」按钮自动配置 Webhook

**方式二：手动配置**

在 Gitea 仓库设置中添加 Webhook：
- **URL**: `http://your-server:3000/webhook/gitea`
- **内容类型**: `application/json`
- **密钥**: 与 `WEBHOOK_SECRET` 相同
- **触发事件**: 「Pull Request」和「Status」

## 配置参考

### 核心配置

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `GITEA_API_URL` | Gitea API 地址 | 必填 |
| `GITEA_ACCESS_TOKEN` | 代码审查令牌（需要读取和评论权限） | 必填 |
| `GITEA_ADMIN_TOKEN` | Webhook 管理令牌（可选） | - |
| `OPENAI_BASE_URL` | OpenAI API 基础地址 | `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | OpenAI API 密钥 | 必填 |
| `OPENAI_MODEL` | 使用的模型 | `gpt-4o-mini` |
| `PORT` | 服务端口 | `3000` |
| `WEBHOOK_SECRET` | Webhook 签名验证密钥 | 必填 |

### 自定义提示词

| 变量 | 描述 |
|------|------|
| `CUSTOM_SUMMARY_PROMPT` | 自定义总结审查提示词 |
| `CUSTOM_LINE_COMMENT_PROMPT` | 自定义行级评论提示词 |

### 管理后台

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `ADMIN_PASSWORD` | 后台登录密码 | `password` |
| `JWT_SECRET` | JWT 签名密钥 | 自动生成 |

### 飞书集成

| 变量 | 描述 |
|------|------|
| `FEISHU_WEBHOOK_URL` | 飞书机器人 Webhook 地址 |
| `FEISHU_WEBHOOK_SECRET` | 飞书 Webhook 密钥（可选） |

### Agent 审查引擎

设置 `REVIEW_ENGINE=agent` 启用多代理审查：

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `REVIEW_ENGINE` | 引擎模式（`legacy` 或 `agent`） | `legacy` |
| `REVIEW_WORKDIR` | 仓库克隆工作目录 | `/tmp/gitea-assistant` |
| `REVIEW_MODEL_PLANNER` | 规划模型 | `gpt-4o-mini` |
| `REVIEW_MODEL_SPECIALIST` | 专家模型 | `gpt-4o-mini` |
| `REVIEW_MODEL_JUDGE` | 判断模型 | `gpt-4o-mini` |
| `REVIEW_MAX_PARALLEL_RUNS` | 最大并发任务数 | `2` |
| `REVIEW_MAX_FILES_PER_RUN` | 单次审查最大文件数 | `200` |
| `REVIEW_AUTO_PUBLISH_MIN_CONFIDENCE` | 自动发布最小置信度 | `0.8` |
| `REVIEW_ENABLE_HUMAN_GATE` | 启用人工审批 | `true` |

### 记忆与学习（实验性）

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `QDRANT_URL` | Qdrant 向量数据库地址 | - |
| `ENABLE_MEMORY` | 启用记忆系统 | `false` |
| `ENABLE_REFLECTION` | 启用自我批评 | `false` |
| `ENABLE_DEBATE` | 启用多代理辩论 | `false` |

## 部署指南

### Docker

```bash
docker build -t gitea-assistant .
docker run -d -p 3000:3000 --env-file .env gitea-assistant
```

### Docker Compose

```bash
docker-compose up -d
```

## 许可证

MIT 许可证
