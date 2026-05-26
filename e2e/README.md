# E2E 真实 PR 审查测试指南

本指南记录使用 Docker 运行 Gitea + Assistant 进行真实 PR 代码审查的完整流程，包括踩坑点和修复步骤。

## 前置条件

- Docker & Docker Compose
- `openssl`（签名计算）
- `python3`（JSON 解析）
- 本项目源码

## 架构概览

```
Gitea (port 3333) ←→ Assistant (port 3334)
     ↑                    ↑
  webhook             clone + comment
  (PR 事件)           (git + API)
```

- **Gitea**：代码托管，运行在 `gitea:3000`（宿主机 `localhost:3333`）
- **Assistant**：AI 审查服务，运行在 `assistant:5174`（宿主机 `localhost:3334`）
- 两者通过 Docker 内部网络 `gitea:3000` 通信（非宿主机地址）

## 一键启动（自动化方式）

```bash
# 1. 启动容器
docker compose -f docker-compose.e2e.yml up -d

# 2. 等待 Gitea healthy 后创建用户（Gitea 不允许 root 执行 admin 命令）
docker exec e2e-gitea su git -c \
  "gitea admin user create --username e2e-admin --password 'e2ePassword123!' \
   --email admin@e2e-test.local --admin --must-change-password=false"

# 3. 运行 seed 脚本（创建仓库、推送代码、配置 webhook、创建 PR）
bash ./e2e/seed.sh

# 4. 用 seed 输出的 token 重启 assistant（使 GITEA_ACCESS_TOKEN 生效）
#    seed.sh 会在最后打印实际 token 值
E2E_GITEA_TOKEN=<seed输出的token> docker compose -f docker-compose.e2e.yml up -d assistant

# 5. 通过 Admin API 更新运行时配置
LOGIN_RESP=$(curl -sf -X POST "http://localhost:3334/admin/api/login" \
  -H "Content-Type: application/json" -d '{"password": "password"}')
JWT=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -sf -X PUT "http://localhost:3334/admin/api/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "GITEA_API_URL": "http://gitea:3000/api/v1",
    "GITEA_ACCESS_TOKEN": "<seed输出的token>",
    "WEBHOOK_SECRET": "e2e-test-secret"
  }'

# 6. 运行 E2E 测试
bash ./e2e/test.sh
```

## 分步详解与踩坑点

### 1. 启动容器

```bash
docker compose -f docker-compose.e2e.yml up -d
```

**踩坑**：`ENCRYPTION_KEY` 和 `WEBHOOK_SECRET` 必须在 `docker-compose.e2e.yml` 中配置，否则 assistant 启动失败（`ENCRYPTION_KEY is required`）。已添加默认值：

```yaml
assistant:
  environment:
    - ENCRYPTION_KEY=${E2E_ENCRYPTION_KEY:-0123456789abcdef...（64位hex）}
    - WEBHOOK_SECRET=e2e-test-secret
```

### 2. 创建 Gitea 用户

```bash
docker exec e2e-gitea su git -c \
  "gitea admin user create --username e2e-admin --password 'e2ePassword123!' \
   --email admin@e2e-test.local --admin --must-change-password=false"
```

**踩坑**：`seed.sh` 中直接 `docker exec e2e-gitea gitea admin user create ...` 会报错 `Gitea is not supposed to be run as root`。必须用 `su git -c` 切换到 git 用户执行。如果用户已存在会输出错误但可忽略。

### 3. Seed 初始化

```bash
bash ./e2e/seed.sh
```

Seed 脚本会执行：
1. 等待 Gitea 就绪
2. 创建管理员用户（如已存在则跳过）
3. 生成 API Token
4. 创建测试仓库并推送含已知 bug 的代码（`src/user-handler.ts` 包含 eval/SQL 注入/硬编码密钥）
5. 配置 Assistant 设置（需要 assistant 已启动）
6. 配置 Gitea Webhook（指向 `http://assistant:5174/webhook/gitea`）
7. 创建 PR #1（`feature/add-user-handler` → `main`）

**踩坑**：seed.sh 第 5 步"配置 Assistant 设置"可能失败（assistant 未启动或 JWT 获取失败），这不影响后续流程——可以手动通过 API 配置。

### 4. 更新 Assistant 运行时配置

```bash
# 获取 JWT
JWT=$(curl -sf -X POST "http://localhost:3334/admin/api/login" \
  -H "Content-Type: application/json" -d '{"password": "password"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# 更新三个关键配置
curl -sf -X PUT "http://localhost:3334/admin/api/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "GITEA_API_URL": "http://gitea:3000/api/v1",
    "GITEA_ACCESS_TOKEN": "<token>",
    "WEBHOOK_SECRET": "e2e-test-secret"
  }'
```

**关键**：
- `GITEA_API_URL` 必须是 `http://gitea:3000/api/v1`（Docker 内部地址），不是 `localhost` 或宿主机地址
- `GITEA_ACCESS_TOKEN` 是 seed.sh 生成的 token，assistant 用它 clone 仓库和发布评论
- `WEBHOOK_SECRET` 必须与 Gitea webhook 的 secret 一致，否则签名验证失败

### 5. 触发 PR 审查

PR 创建时 Gitea 会自动触发 webhook。如果需要手动触发：

```bash
# 获取 PR 信息
PR_RESP=$(curl -sf "http://localhost:3333/api/v1/repos/e2e-admin/e2e-test-repo/pulls/1" \
  -H "Authorization: token <token>")

HEAD_SHA=$(echo "$PR_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['head']['sha'])")
BASE_SHA=$(echo "$PR_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['base']['sha'])")

# 构造 webhook payload（需包含 head/base SHA）
cat > /tmp/webhook_payload.json << EOF
{
  "action": "opened",
  "number": 1,
  "pull_request": {
    "number": 1,
    "title": "feat: add user handler",
    "head": { "ref": "feature/add-user-handler", "sha": "$HEAD_SHA",
              "repo": { "clone_url": "http://gitea:3000/e2e-admin/e2e-test-repo.git" } },
    "base": { "ref": "main", "sha": "$BASE_SHA",
              "repo": { "clone_url": "http://gitea:3000/e2e-admin/e2e-test-repo.git" } }
  },
  "repository": {
    "full_name": "e2e-admin/e2e-test-repo",
    "owner": { "login": "e2e-admin" },
    "clone_url": "http://gitea:3000/e2e-admin/e2e-test-repo.git"
  },
  "sender": { "login": "e2e-admin" }
}
EOF

# 计算 HMAC 签名
PAYLOAD=$(cat /tmp/webhook_payload.json)
SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "e2e-test-secret" -binary | xxd -p -c 256)

# 发送 webhook
curl -s -X POST "http://localhost:3334/webhook/gitea" \
  -H "Content-Type: application/json" \
  -H "X-Gitea-Signature: ${SIG}" \
  -d "$PAYLOAD"
```

### 6. 验证审查结果

```bash
# 等待审查完成
sleep 10

# 检查 assistant 日志
docker logs e2e-assistant 2>&1 | grep -E "审查|publish|评论|finding|ERROR" | tail -20

# 通过 API 查看 run 详情
curl -sf "http://localhost:3334/admin/api/review/runs" \
  -H "Authorization: Bearer $JWT" | python3 -m json.tool | head -30

# 检查 Gitea PR 评论（summary）
curl -sf "http://localhost:3333/api/v1/repos/e2e-admin/e2e-test-repo/issues/1/comments" \
  -H "Authorization: token <token>" | python3 -c "
import sys,json
for c in json.load(sys.stdin):
    print(c['body'][:200])
"

# 检查 Gitea PR Reviews（行级评论）
curl -sf "http://localhost:3333/api/v1/repos/e2e-admin/e2e-test-repo/pulls/1/reviews" \
  -H "Authorization: token <token>"
```

## 验证检查清单

| # | 检查项 | 验证方式 |
|---|--------|----------|
| 1 | Gitea 容器 healthy | `docker ps` 或 `curl localhost:3333/api/v1/version` |
| 2 | Assistant 容器 healthy | `curl localhost:3334/api/health` |
| 3 | Webhook 签名验证通过 | assistant 日志无"签名验证失败" |
| 4 | Git clone mirror 成功 | assistant 日志无"could not read Username" |
| 5 | Agent 审查执行完成 | run status = `succeeded` |
| 6 | Subagent 被触发 | sessionTree.invocations 非空 |
| 7 | Findings 数量 > 0 | run details 中 findings 非空 |
| 8 | Summary 评论发布到 Gitea | PR issue comments 包含"AI Agent代码审查结果" |
| 9 | 行级评论发布到 Gitea | PR reviews 包含 COMMENT 类型 |
| 10 | Finding published=true | DB 中 finding.published = true |

## Mock LLM vs 真实 LLM

| 特性 | E2E_MOCK_LLM=1 | 真实 LLM |
|------|----------------|----------|
| 模型 | `RuntimeE2EMockLLM`（脚本驱动） | OpenAI/Anthropic/其他 |
| Subagent | 必然调用（固定脚本） | 动态决策（根据 diff 复杂度） |
| Findings | 固定 1 条（eval 安全问题） | 根据实际代码动态发现 |
| 速度 | <1s | 10-60s |
| 用途 | 集成链路验证 | 审查质量验证 |

## 常见问题

### `ENCRYPTION_KEY is required`
**原因**：`docker-compose.e2e.yml` 缺少 `ENCRYPTION_KEY` 环境变量。
**修复**：已在 compose 文件中添加默认值。

### `Webhook签名验证失败`
**原因**：请求的 HMAC 签名与 assistant 配置的 `WEBHOOK_SECRET` 不匹配。
**修复**：确保 webhook payload 的签名计算使用与 Admin API 配置的 `WEBHOOK_SECRET` 相同的密钥。

### `could not read Username for 'http://gitea:3000'`
**原因**：`GITEA_ACCESS_TOKEN` 未正确配置（默认值 `placeholder`）或 DB 配置中的值不正确。
**修复**：通过 Admin API 更新 `GITEA_ACCESS_TOKEN` 为 seed.sh 生成的实际 token。

### `Gitea is not supposed to be run as root`
**原因**：Gitea 容器以 root 运行，但 `gitea admin` 命令不允许 root 执行。
**修复**：使用 `docker exec e2e-gitea su git -c "gitea admin user create ..."` 格式。

### Gitea API URL 指向 localhost
**原因**：assistant DB 中 `GITEA_API_URL` 默认值为 `http://localhost:5174/api/v1`（自身地址）。
**修复**：通过 Admin API 更新为 `http://gitea:3000/api/v1`（Docker 内部地址）。

### 评论未发布到 Gitea
**原因**：Agent 引擎的 `publishPendingComments` 链路缺失（已修复）。
**修复**：确保使用包含 `publishPendingComments` 逻辑的版本。

## 清理

```bash
docker compose -f docker-compose.e2e.yml down -v
```

`-v` 会删除 Gitea 数据卷，下次启动需要重新 seed。
