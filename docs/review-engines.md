# Review Engines

The system supports two review engines, selected by `REVIEW_ENGINE` in Admin UI.

## Agent engine

The Agent engine uses a dynamic agent framework. It prepares the workspace and review context, then starts a main agent to perform the review.

### How it works

1. **Main Agent** — the entrypoint agent that coordinates the review. It uses available tools to analyze code changes.
2. **Dynamic Subagents** — the main agent can autonomously spawn subagents for focused tasks (e.g. searching code, reading files). Subagents are created at runtime through tool calls, not hardcoded in the workflow.
3. **Deterministic Publishing** — findings and comments are collected and processed outside the agent loop. The system normalizes, deduplicates, and filters findings deterministically before posting to Gitea.

### Review modes

| Mode | Behavior |
|---|---|
| `skip` | Low-risk changes bypass review entirely |
| `light` | Minimal checks for low-risk code changes |
| `full` | Complete review for risky or large changes |

### Size policy

Change size determines execution mode and token budgets:

| Size | Typical threshold |
|---|---|
| `small` | Few lines changed |
| `medium` | Moderate change set |
| `large` | Significant refactoring or many files |

> Size and mode are separate layers: `small/medium/large` classifies how big the change is; `skip/light/full` controls how deeply the engine reviews it.

## Codex engine

The Codex engine runs review through Codex CLI with independent runtime settings:

| Setting | Description |
|---|---|
| `CODEX_API_URL` | Codex API endpoint |
| `CODEX_API_KEY` | Codex API key |
| `CODEX_MODEL` | Model to use |
| `CODEX_TIMEOUT_MS` | Request timeout |
| `CODEX_REVIEW_PROMPT` | Custom review prompt |

## Agent definitions

Agent definitions are Markdown files with YAML frontmatter stored in the reviewed repository:

```
.gitea-assistant/agents/*.md
```

Each file defines:

- **System prompt** — instructions for the agent
- **Model** — which LLM model to use (optional; falls back to runtime defaults)
- **Max turns** — limit for the agent loop
- **Tools** — which tools the agent can access

### Model resolution

When the main agent spawns a subagent, the model is resolved in this order:

1. `spawn` override (explicit in the tool call)
2. `AgentDefinition.model` (declared in the agent definition file)
3. `AGENT_DEFAULT_SUBAGENT_MODEL` (runtime config)
4. `AGENT_MAIN_MODEL` (runtime config)

## Tool permissions

Tool permissions are controlled within each agent's definition file:

| Field | Type | Description |
|---|---|---|
| `tools` | Allow list | Tool names the agent is permitted to call. Empty list grants no tools. |
| `disallowedTools` | Deny list | Tool names the agent is explicitly forbidden from calling. Takes precedence over `tools`. |

## Event support

Both engines process:

- Pull request webhook events
- Commit status webhook events

## Output

- PR/commit summary comment (posted as an issue comment)
- Line-level findings with confidence and severity (posted as review comments)
