# Review Engines

## Overview

The system supports two engines:

- `agent`: native Agent review pipeline
- `codex`: Codex CLI-backed review pipeline

Engine is selected by `REVIEW_ENGINE` runtime configuration.

## Agent engine

The Agent engine runs code reviews using a dynamic agent framework. It prepares the workspace and review context, then starts a main agent to perform the review.

### Review behavior

- **Main Agent**: The entrypoint agent that coordinates the review process. It uses the tools provided to analyze the code changes.
- **Dynamic Subagents**: The main agent can dynamically spawn subagents to perform specific tasks, such as searching code or reading files, if needed.
- **Deterministic Publishing**: Review findings and comments are collected and processed outside the agent loop. The system normalizes, deduplicates, and filters findings deterministically before posting them back to Gitea.

### Review modes

- `skip`: Low-risk changes may bypass the agent review entirely.
- `light`: Minimal checks for low-risk code changes.
- `full`: Full review for risky or larger changes.

### Size policy

`small`/`medium`/`large` thresholds are used to classify the change size, which determines the execution mode and token budgets.

## Codex engine

Codex engine runs review through Codex CLI with independent runtime settings:

- `CODEX_API_URL`
- `CODEX_API_KEY`
- `CODEX_MODEL`
- `CODEX_TIMEOUT_MS`
- `CODEX_REVIEW_PROMPT`

## Event support

Both engines process:

- Pull request webhook events
- Commit status webhook events

## Output

- PR/commit summary comment
- Line-level findings with confidence and severity
