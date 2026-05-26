# 审查引擎

## 概览

系统支持两种审查引擎：

- `agent`：内置 Agent 审查流水线
- `codex`：基于 Codex CLI 的审查流水线

通过运行时配置 `REVIEW_ENGINE` 选择引擎。

## Agent 引擎

Agent 引擎使用动态 Agent 框架执行代码审查。它会准备工作区与审查上下文，然后启动主 Agent 执行审查任务。

### 审查行为

- **主 Agent**：协调审查流程的入口 Agent。它使用提供的工具来分析代码变更。
- **动态子 Agent**：主 Agent 可以根据需要动态生成子 Agent，以执行特定任务（例如搜索代码或读取文件）。
- **确定性发布**：审查发现的问题与评论会在 Agent 循环之外进行收集和处理。系统会在将结果发布回 Gitea 之前，对发现的问题进行确定性的规范化、去重和过滤。

### 审查模式

- `skip`：低风险改动可完全跳过 Agent 审查。
- `light`：对低风险代码执行最小化检查。
- `full`：对高风险或大规模改动执行完整审查。

### 规模策略

`small` / `medium` / `large` 阈值用于对变更规模进行分类，从而决定执行模式与 Token 预算。

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
