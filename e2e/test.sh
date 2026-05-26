#!/usr/bin/env bash
set -euo pipefail

# E2E Test Script
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

MAX_WAIT=240
POLL_INTERVAL=5
PASS=0
FAIL=0
RUN_ID=""
LATEST_DETAIL='{}'

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

if [ "${E2E_MOCK_LLM:-}" = "1" ]; then
  echo "  E2E_MOCK_LLM=1 (shell env)"
else
  echo "  E2E_MOCK_LLM 由 assistant 容器环境决定（docker-compose.e2e.yml 已配置）"
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

echo "[TEST 4] Admin 登录"
ADMIN_JWT=$(curl -sf -X POST "${ASSISTANT_URL}/admin/api/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"password"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")

if [ -n "${ADMIN_JWT}" ]; then
  echo "  ✅ PASS: Admin JWT 获取成功"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: Admin JWT 获取失败"
  FAIL=$((FAIL + 1))
fi

echo "[TEST 5] 等待 review run 产出并成功（最多等待 ${MAX_WAIT}s）"
RUNS=$(curl -sf "${ASSISTANT_URL}/admin/api/review/runs" \
  -H "Authorization: Bearer ${ADMIN_JWT}" 2>/dev/null || echo "[]")
RUN_COUNT=$(echo "${RUNS}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',d if isinstance(d,list) else [])))" 2>/dev/null || echo "0")

WAITED=0
while [ ${WAITED} -lt ${MAX_WAIT} ]; do
  RUNS=$(curl -sf "${ASSISTANT_URL}/admin/api/review/runs" \
    -H "Authorization: Bearer ${ADMIN_JWT}" 2>/dev/null || echo "{}")
  RUN_ID=$(echo "${RUNS}" | python3 -c "import sys,json; d=json.load(sys.stdin); runs=d.get('data', d if isinstance(d,list) else []); print(runs[0]['id'] if runs else '')" 2>/dev/null || echo "")
  RUN_STATUS=$(echo "${RUNS}" | python3 -c "import sys,json; d=json.load(sys.stdin); runs=d.get('data', d if isinstance(d,list) else []); print(runs[0].get('status','') if runs else '')" 2>/dev/null || echo "")
  if [ -n "${RUN_ID}" ] && [ "${RUN_STATUS}" = "succeeded" ]; then
    echo "  ✅ PASS: run=${RUN_ID} status=succeeded (${WAITED}s)"
    PASS=$((PASS + 1))
    break
  fi
  echo "  ⏳ 等待 run... (${WAITED}/${MAX_WAIT}s, run=${RUN_ID:-none}, status=${RUN_STATUS:-none})"
  sleep ${POLL_INTERVAL}
  WAITED=$((WAITED + POLL_INTERVAL))
done

if [ -z "${RUN_ID}" ]; then
  echo "  ❌ FAIL: 未发现 review run"
  FAIL=$((FAIL + 1))
fi

if [ -n "${RUN_ID}" ]; then
  LATEST_DETAIL=$(curl -sf "${ASSISTANT_URL}/admin/api/review/runs/${RUN_ID}" \
    -H "Authorization: Bearer ${ADMIN_JWT}" 2>/dev/null || echo '{}')
fi

echo "[TEST 6] 会话树包含主/子 Agent 与工具调用"
TREE_ASSERT=$(echo "${LATEST_DETAIL}" | python3 -c '
import json,sys
d=json.load(sys.stdin)
t=d.get("sessionTree") or {}
main_type=t.get("agentType")
main_tools=[x.get("toolName") for x in t.get("toolCalls",[])]
inv=t.get("invocations",[])
has_spawn="spawn_subagent" in main_tools
child_ok=False
if inv:
    child=inv[0].get("childSession") or {}
    child_tools=[x.get("toolName") for x in child.get("toolCalls",[])]
    child_ok=("search_code" in child_tools and "read_file" in child_tools)
print("ok" if (main_type=="review-main-agent" and has_spawn and len(inv)>0 and child_ok) else "bad")
' 2>/dev/null || echo "bad")

if [ "${TREE_ASSERT}" = "ok" ]; then
  echo "  ✅ PASS: 主会话与子代理调用链存在（含 search_code/read_file）"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: sessionTree 未满足动态子代理断言"
  echo "${LATEST_DETAIL}" | python3 -m json.tool 2>/dev/null || true
  FAIL=$((FAIL + 1))
fi

echo "[TEST 7] run details 包含 findings 与评论记录"
DETAIL_ASSERT=$(echo "${LATEST_DETAIL}" | python3 -c '
import json,sys
d=json.load(sys.stdin)
findings=d.get("findings",[])
comments=d.get("comments",[])
ok=(len(findings) > 0 and len(comments) > 0)
print("ok" if ok else "bad")
' 2>/dev/null || echo "bad")

if [ "${DETAIL_ASSERT}" = "ok" ]; then
  echo "  ✅ PASS: run details 存在 findings/comments"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: run details 缺少 findings 或 comments"
  FAIL=$((FAIL + 1))
fi

echo "[TEST 8] Gitea 评论产物（summary + line comments）"
ISSUE_COMMENTS=$(curl -sf "${GITEA_URL}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/issues/${PR_NUMBER}/comments" \
  -H "Authorization: token ${GITEA_TOKEN}" 2>/dev/null || echo "[]")
LINE_COMMENTS=$(curl -sf "${GITEA_URL}/api/v1/repos/${ADMIN_USER}/${REPO_NAME}/pulls/${PR_NUMBER}/comments" \
  -H "Authorization: token ${GITEA_TOKEN}" 2>/dev/null || echo "[]")

SUMMARY_COUNT=$(echo "${ISSUE_COMMENTS}" | python3 -c '
import json,sys
arr=json.load(sys.stdin)
cnt=0
for c in arr:
    body=c.get("body") or ""
    if "审查" in body or "review" in body.lower() or "AI" in body:
        cnt += 1
print(cnt)
' 2>/dev/null || echo "0")
LINE_COUNT=$(echo "${LINE_COMMENTS}" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo "0")

if [ "${SUMMARY_COUNT}" -gt "0" ] && [ "${LINE_COUNT}" -gt "0" ]; then
  echo "  ✅ PASS: summary=${SUMMARY_COUNT}, line_comments=${LINE_COUNT}"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL: Gitea 评论产物不足（summary=${SUMMARY_COUNT}, line_comments=${LINE_COUNT}）"
  echo "  --- issue comments ---"
  echo "${ISSUE_COMMENTS}" | python3 -m json.tool 2>/dev/null || true
  echo "  --- line comments ---"
  echo "${LINE_COMMENTS}" | python3 -m json.tool 2>/dev/null || true
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
  echo "⚠️  部分测试失败。请检查:"
  echo "  1. docker compose e2e 容器均 healthy"
  echo "  2. assistant 容器环境含 E2E_MOCK_LLM=1 与正确 GITEA_ACCESS_TOKEN"
  echo "  3. webhook 已触发且 run details 可见 sessionTree/findings/comments"
  exit 1
else
  echo ""
  echo "🎉 所有 E2E 测试通过！"
  exit 0
fi
