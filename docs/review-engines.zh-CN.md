# 审查引擎

系统支持两种审查引擎，通过管理后台的 `REVIEW_ENGINE` 配置选择。

## Agent 引擎

Agent 引擎使用动态 Agent 框架执行代码审查。它会准备工作区与审查上下文，然后启动主 Agent 执行审查任务。

### 工作原理

1. **主 Agent** — 协调审查流程的入口 Agent，使用可用工具分析代码变更。
2. **动态子 Agent** — 主 Agent 可在运行时自主生成子 Agent，执行聚焦任务（如搜索代码、读取文件）。子 Agent 通过工具调用动态创建，而非硬编码在工作流中。
3. **确定性发布** — 审查发现与评论在 Agent 循环之外收集和处理。系统在发布到 Gitea 之前，对发现进行确定性的规范化、去重和过滤。

### 审查模式

| 模式 | 行为 |
|---|---|
| `skip` | 低风险改动完全跳过审查 |
| `light` | 对低风险代码执行最小化检查 |
| `full` | 对高风险或大规模改动执行完整审查 |

### 规模策略

变更规模决定执行模式与 Token 预算：

| 规模 | 典型阈值 |
|---|---|
| `small` | 少量行变更 |
| `medium` | 中等变更集 |
| `large` | 大规模重构或多文件变更 |

> 规模与模式是两个层次：`small/medium/large` 分类变更的大小；`skip/light/full` 控制审查的深度。

## Codex 引擎

Codex 引擎通过 Codex CLI 执行审查，支持独立配置：

| 设置项 | 说明 |
|---|---|
| `CODEX_API_URL` | Codex API 端点 |
| `CODEX_API_KEY` | Codex API 密钥 |
| `CODEX_MODEL` | 使用的模型 |
| `CODEX_TIMEOUT_MS` | 请求超时时间 |
| `CODEX_REVIEW_PROMPT` | 自定义审查提示词 |

## Agent 定义

Agent 定义以带 YAML Frontmatter 的 Markdown 文件形式存储在被审查的仓库中：

```
.gitea-assistant/agents/*.md
```

每个文件定义：

- **系统提示词** — Agent 的指令
- **模型** — 使用的 LLM 模型（可选；未指定时使用运行时默认值）
- **最大轮数** — Agent 循环上限
- **工具** — Agent 可使用的工具

### 模型解析

主 Agent 生成子 Agent 时，模型按以下顺序解析：

1. `spawn` 覆盖（工具调用中显式指定）
2. `AgentDefinition.model`（Agent 定义文件中声明）
3. `AGENT_DEFAULT_SUBAGENT_MODEL`（运行时配置）
4. `AGENT_MAIN_MODEL`（运行时配置）

## 工具权限

工具权限在每个 Agent 的定义文件中控制：

| 字段 | 类型 | 说明 |
|---|---|---|
| `tools` | 白名单 | 允许该 Agent 调用的工具名称。空列表表示不授予任何工具权限 |
| `disallowedTools` | 黑名单 | 显式禁止该 Agent 调用的工具名称。优先级高于白名单 |

## 事件支持

两种引擎都支持：

- Pull Request webhook 事件
- Commit Status webhook 事件

## 输出

- PR/提交总结评论（作为 Issue 评论发布）
- 行级问题（含置信度与严重性，作为审查评论发布）
