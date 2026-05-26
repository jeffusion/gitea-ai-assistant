#!/usr/bin/env bash
set -euo pipefail

# E2E Seed Script
# 初始化 Gitea 测试环境：创建用户、生成 Token、创建仓库、推送代码、配置 Webhook、创建 PR
#
# 前置条件: docker compose -f docker-compose.e2e.yml up -d && 等待 healthy
# 产出: 写入 e2e/.env.e2e 供 test.sh 使用

GITEA_URL="http://localhost:3333"
ASSISTANT_URL="http://localhost:3334"
ADMIN_USER="e2e-admin"
ADMIN_PASS="e2ePassword123!"
ADMIN_EMAIL="admin@e2e-test.local"
WEBHOOK_SECRET="e2e-test-secret"
REPO_NAME="e2e-test-repo"

echo "=== [1/6] 等待 Gitea 就绪 ==="
for i in $(seq 1 30); do
  if curl -sf "${GITEA_URL}/api/v1/version" > /dev/null 2>&1; then
    echo "Gitea 已就绪"
    break
  fi
  echo "  等待中... ($i/30)"
  sleep 2
done

echo "=== [2/6] 创建管理员用户 ==="
docker exec e2e-gitea su git -c "gitea admin user create \
--username '${ADMIN_USER}' \
--password '${ADMIN_PASS}' \
--email '${ADMIN_EMAIL}' \
--admin \
--must-change-password=false" 2>/dev/null || echo " 用户已存在，跳过"

echo "=== [3/6] 生成 API Token ==="
TOKEN_RESPONSE=$(curl -sf -X POST "${GITEA_URL}/api/v1/users/${ADMIN_USER}/tokens" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"e2e-token-$(date +%s)\", \"scopes\": [\"all\"]}" 2>/dev/null || true)

if [ -z "${TOKEN_RESPONSE}" ]; then
  echo "  Token 创建失败，尝试使用密码认证"
  GITEA_TOKEN=""
else
  GITEA_TOKEN=$(echo "${TOKEN_RESPONSE}" | grep -o '"sha1":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -z "${GITEA_TOKEN}" ]; then
    GITEA_TOKEN=$(echo "${TOKEN_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sha1',''))" 2>/dev/null || true)
  fi
fi

if [ -z "${GITEA_TOKEN}" ]; then
  echo "  ERROR: 无法获取 Token"
  exit 1
fi
echo "  Token: ${GITEA_TOKEN:0:8}..."

echo "=== [4/6] 创建测试仓库并推送代码 ==="
curl -sf -X POST "${GITEA_URL}/api/v1/user/repos" \
  -H "Authorization: token ${GITEA_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"${REPO_NAME}\", \"auto_init\": true, \"default_branch\": \"main\"}" > /dev/null 2>&1 || echo "  仓库已存在，跳过"

CLONE_DIR=$(mktemp -d)
trap "rm -rf ${CLONE_DIR}" EXIT

git clone "http://${ADMIN_USER}:${ADMIN_PASS}@localhost:3333/${ADMIN_USER}/${REPO_NAME}.git" "${CLONE_DIR}/repo" 2>/dev/null

pushd "${CLONE_DIR}/repo" > /dev/null
git config user.email "e2e@test.local"
git config user.name "E2E Bot"

mkdir -p src
cat > src/auth.ts << 'TSEOF'
export function authenticate(token: string): boolean {
  // 正确的认证实现
  if (!token || token.length < 10) {
    return false;
  }
  return verifyToken(token);
}

function verifyToken(token: string): boolean {
  return token.startsWith('valid-');
}
TSEOF

git add -A
git commit -m "initial: add auth module" --allow-empty 2>/dev/null || true
git push origin main 2>/dev/null || true

git checkout -b feature/add-user-handler
cat > src/user-handler.ts << 'TSEOF'
import { authenticate } from './auth';

export function handleUserRequest(input: any) {
  // Bug: 没有对 input 做 null 检查
  const userId = input.userId;

  // Bug: SQL 注入风险
  const query = `SELECT * FROM users WHERE id = '${userId}'`;

  // Bug: 硬编码密钥
  const secret = "super-secret-api-key-12345";

  // Bug: 不安全的 eval
  const config = eval(input.config);

  return { query, config };
}
TSEOF

git add -A
git commit -m "feat: add user handler"
git push origin feature/add-user-handler 2>/dev/null
popd > /dev/null

echo "=== [5/7] 配置 Assistant 设置 ==="
ADMIN_DEFAULT_PASS="password"

# Wait for assistant to be healthy
for i in $(seq 1 20); do
  if curl -sf "${ASSISTANT_URL}/" > /dev/null 2>&1; then
    echo "  Assistant 已就绪"
    break
  fi
  echo "  等待 Assistant... ($i/20)"
  sleep 3
done

# Login to get JWT
LOGIN_RESP=$(curl -sf -X POST "${ASSISTANT_URL}/admin/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\": \"${ADMIN_DEFAULT_PASS}\"}" 2>/dev/null || true)
ADMIN_JWT=$(echo "${LOGIN_RESP}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || true)

if [ -z "${ADMIN_JWT}" ]; then
  echo "  WARNING: 无法获取管理员 JWT，跳过 assistant 配置"
else
  echo "  JWT 获取成功，配置 assistant 设置..."
  curl -sf -X PUT "${ASSISTANT_URL}/admin/api/config" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${ADMIN_JWT}" \
    -d "{
      \"WEBHOOK_SECRET\": \"${WEBHOOK_SECRET}\",
      \"GITEA_API_URL\": \"http://gitea:3000/api/v1\",
      \"REVIEW_ENGINE\": \"agent\",
      \"REVIEW_WORKDIR\": \"/tmp/e2e-review\",
      \"REVIEW_ALLOWED_COMMANDS\": \"git,rg,cat,sed,wc\",
      \"REVIEW_COMMAND_TIMEOUT_MS\": \"120000\"
    }" > /dev/null 2>&1 && echo "  Assistant 配置完成" || echo "  WARNING: assistant 配置失败"
fi

echo "=== [6/7] 配置 Webhook ==="
curl -sf -X POST "${GITEA_URL}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/hooks" \
  -H "Authorization: token ${GITEA_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"gitea\",
    \"active\": true,
    \"events\": [\"pull_request\"],
    \"config\": {
      \"url\": \"http://assistant:5174/webhook/gitea\",
      \"content_type\": \"json\",
      \"secret\": \"${WEBHOOK_SECRET}\"
    }
  }" > /dev/null 2>&1 || echo "  Webhook 配置失败（可能已存在）"
echo "=== [7/7] 创建 Pull Request ==="
PR_RESPONSE=$(curl -sf -X POST "${GITEA_URL}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/pulls" \
  -H "Authorization: token ${GITEA_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"feat: add user handler\",
    \"body\": \"Add user request handler with authentication\",
    \"head\": \"feature/add-user-handler\",
    \"base\": \"main\"
  }" 2>/dev/null || true)

PR_NUMBER=$(echo "${PR_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('number',''))" 2>/dev/null || echo "")

if [ -z "${PR_NUMBER}" ]; then
  echo "  PR 创建失败或已存在，尝试查找现有 PR..."
  PR_NUMBER=$(curl -sf "${GITEA_URL}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/pulls?state=open" \
    -H "Authorization: token ${GITEA_TOKEN}" | \
    python3 -c "import sys,json; prs=json.load(sys.stdin); print(prs[0]['number'] if prs else '')" 2>/dev/null || echo "1")
fi

echo "  PR #${PR_NUMBER} 已创建"

cat > e2e/.env.e2e << EOF
GITEA_URL=${GITEA_URL}
ASSISTANT_URL=${ASSISTANT_URL}
GITEA_TOKEN=${GITEA_TOKEN}
ADMIN_USER=${ADMIN_USER}
REPO_NAME=${REPO_NAME}
PR_NUMBER=${PR_NUMBER}
EOF

echo ""
echo "=== Seed 完成 ==="
echo "  Gitea:     ${GITEA_URL}"
echo "  Assistant:  ${ASSISTANT_URL}"
echo "  Repo:      ${ADMIN_USER}/${REPO_NAME}"
echo "  PR:        #${PR_NUMBER}"
echo "  Token:     ${GITEA_TOKEN:0:8}..."
echo ""
echo "下一步:"
echo "  1. 更新 assistant 容器的 GITEA_ACCESS_TOKEN:"
echo "     E2E_GITEA_TOKEN=${GITEA_TOKEN} docker compose -f docker-compose.e2e.yml up -d assistant"
echo "  2. 运行测试: ./e2e/test.sh"
