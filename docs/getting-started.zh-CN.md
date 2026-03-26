# 快速开始

## 环境要求

- Bun >= 1.2.5
- 可访问的 Gitea 实例
- 至少一个 LLM 提供商凭证

## 安装

```bash
git clone https://github.com/user/gitea-ai-assistant.git
cd gitea-ai-assistant
bun install
```

在仓库根目录执行 `bun install` 会通过 `postinstall` 自动安装 `frontend` 依赖。

如果你的环境禁用了生命周期脚本：

```bash
bun run bootstrap
```

## 最小环境变量

创建 `.env` 文件：

```bash
PORT=5174
ENCRYPTION_KEY= # 必填，使用 openssl rand -hex 32 生成
# DATABASE_PATH=./data/assistant.db
# LOG_LEVEL=info   # 本地开发默认；生产环境请使用 LOG_LEVEL=error
```

> `ENCRYPTION_KEY` 为必填项，缺失时服务会拒绝启动。

## 启动服务

```bash
bun run dev
# 或
bun run start
```

## 首次登录

- 访问 `http://your-server:5174`
- 首次启动默认管理员密码为 `password`
- 登录后请立即修改管理员密码

## Webhook 配置

### 方式 A：管理后台（推荐）

在仓库列表点击启用按钮，由系统自动配置 webhook。

### 方式 B：手动配置

在 Gitea 仓库设置中配置：

- URL：`http://your-server:5174/webhook/gitea`
- Content Type：`application/json`
- Secret：与管理后台中的 Webhook Secret 保持一致
- 事件：Pull Request + Status

## 健康检查

可通过 `/api/health` 查看服务状态。
