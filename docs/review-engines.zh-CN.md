# 审查引擎

## 概览

系统支持两种审查引擎：

- `agent`：原生任务化分级审查
- `codex`：基于 Codex CLI 的审查流水线

通过运行时配置 `REVIEW_ENGINE` 选择引擎。

## Agent 引擎

Agent 引擎会先做变更分流，再按领域派发 specialist 任务。

### 审查模式

- `skip`：低风险改动可跳过 specialist
- `light`：对低风险代码执行最小化专项检查
- `full`：对高风险或大规模改动执行完整审查

### 规模策略

`small` / `medium` / `large` 阈值用于 triage 阶段决策模式与 token 预算。

## Codex 引擎

Codex 引擎通过 Codex CLI 执行审查，支持独立配置：

- `CODEX_API_URL`
- `CODEX_API_KEY`
- `CODEX_MODEL`
- `CODEX_TIMEOUT_MS`
- `CODEX_REVIEW_PROMPT`

## 事件支持

两种引擎都支持：

- Pull Request webhook 事件
- Commit Status webhook 事件

## 输出

- PR/提交总结评论
- 行级问题（含置信度与严重性）
