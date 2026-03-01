#!/usr/bin/env bash
set -euo pipefail

# E2E Test Script
# 验证 AI 代码审查是否在 PR 上产生了评论
#
# 前置条件:
#   1. docker compose -f docker-compose.e2e.yml up -d
#   2. ./e2e/seed.sh
#   3. E2E_GITEA_TOKEN=xxx docker compose -f docker-compose.e2e.yml up -d assistant

ENV_FILE="e2e/.env.e2e"
if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: ${ENV_FILE} 不存在，请先运行 ./e2e/seed.sh"
  exit 1
fi

source "${ENV_FILE}"

MAX_WAIT=180  # 最多等待 3 分钟
POLL_INTERVAL=5
PASS=0
FAIL=0

echo "=== E2E 测试开始 ==="
echo "  Gitea:  ${GITEA_URL}"
echo "  Repo:   ${ADMIN_USER}/${REPO_NAME}"
echo "  PR:     #${PR_NUMBER}"
echo ""

# ─── 测试 1: Assistant 服务健康检查 ───
echo "[TEST 1] Assistant 服务健康检查"
if curl -sf "${ASSISTANT_URL}/" > /dev/null 2>&1; then
  echo "  ✅ PASS: Assistant 服务正常"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: Assistant 服务不可达"
  FAIL=$((FAIL + 1))
fi

# ─── 测试 2: Gitea API 可用 ───
echo "[TEST 2] Gitea API 可用性"
VERSION=$(curl -sf "${GITEA_URL}/api/v1/version" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null || echo "unknown")
if [ "${VERSION}" != "unknown" ]; then
  echo "  ✅ PASS: Gitea v${VERSION}"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: Gitea API 不可用"
  FAIL=$((FAIL + 1))
fi

# ─── 测试 3: PR 存在 ───
echo "[TEST 3] PR 存在性"
PR_STATE=$(curl -sf "${GITEA_URL}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/pulls/${PR_NUMBER}" \
  -H "Authorization: token ${GITEA_TOKEN}" | \
  python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || echo "")

if [ "${PR_STATE}" = "open" ]; then
  echo "  ✅ PASS: PR #${PR_NUMBER} 状态为 open"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: PR #${PR_NUMBER} 状态异常 (${PR_STATE})"
  FAIL=$((FAIL + 1))
fi

# ─── 测试 4: 等待 AI 审查评论出现 ───
echo "[TEST 4] AI 审查评论（最多等待 ${MAX_WAIT}s）"
COMMENT_FOUND=false
WAITED=0

while [ ${WAITED} -lt ${MAX_WAIT} ]; do
  COMMENTS=$(curl -sf "${GITEA_URL}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/issues/${PR_NUMBER}/comments" \
    -H "Authorization: token ${GITEA_TOKEN}" 2>/dev/null || echo "[]")

  AI_COMMENTS=$(echo "${COMMENTS}" | python3 -c "
import sys, json
comments = json.load(sys.stdin)
ai = [c for c in comments if 'AI' in c.get('body', '') or 'Agent' in c.get('body', '')]
print(len(ai))
" 2>/dev/null || echo "0")

  if [ "${AI_COMMENTS}" -gt "0" ]; then
    COMMENT_FOUND=true
    echo "  ✅ PASS: 发现 ${AI_COMMENTS} 条 AI 审查评论 (${WAITED}s)"
    PASS=$((PASS + 1))
    break
  fi

  echo "  ⏳ 等待中... (${WAITED}/${MAX_WAIT}s, 已有评论: $(echo "${COMMENTS}" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0))"
  sleep ${POLL_INTERVAL}
  WAITED=$((WAITED + POLL_INTERVAL))
done

if [ "${COMMENT_FOUND}" = false ]; then
  echo "  ❌ FAIL: ${MAX_WAIT}s 内未发现 AI 审查评论"
  FAIL=$((FAIL + 1))

  echo "  --- 调试信息 ---"
  echo "  PR 所有评论:"
  curl -sf "${GITEA_URL}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/issues/${PR_NUMBER}/comments" \
    -H "Authorization: token ${GITEA_TOKEN}" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "  (无法获取)"

  echo "  Assistant review runs:"
  curl -sf "${ASSISTANT_URL}/admin/api/review/runs" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "  (无法获取)"
fi

# ─── 测试 5: Review Run 状态检查 ───
echo "[TEST 5] Review Run 状态"
RUNS=$(curl -sf "${ASSISTANT_URL}/admin/api/review/runs" 2>/dev/null || echo "[]")
RUN_COUNT=$(echo "${RUNS}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else len(d.get('runs',[])))" 2>/dev/null || echo "0")

if [ "${RUN_COUNT}" -gt "0" ]; then
  echo "  ✅ PASS: 发现 ${RUN_COUNT} 个 review run(s)"
  PASS=$((PASS + 1))

  echo "${RUNS}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
runs = data if isinstance(data, list) else data.get('runs', [])
for r in runs[:3]:
    print(f\"    - {r.get('id','?')[:8]}... status={r.get('status','?')} attempts={r.get('attempts','?')}\")
" 2>/dev/null || true
else
  echo "  ❌ FAIL: 无 review runs"
  FAIL=$((FAIL + 1))
fi

# ─── 结果汇总 ───
echo ""
echo "=== E2E 测试结果 ==="
TOTAL=$((PASS + FAIL))
echo "  通过: ${PASS}/${TOTAL}"
echo "  失败: ${FAIL}/${TOTAL}"

if [ ${FAIL} -gt 0 ]; then
  echo ""
  echo "⚠️  部分测试失败。如果 AI 评论测试失败，请确保:"
  echo "  1. OPENAI_API_KEY 已正确配置"
  echo "  2. assistant 容器的 GITEA_ACCESS_TOKEN 已设置为 seed 生成的 token"
  echo "  3. Webhook 已正确触发（检查 Gitea webhook 日志）"
  exit 1
else
  echo ""
  echo "🎉 所有 E2E 测试通过！"
  exit 0
fi
