# Review Engines

## Overview

The system supports two engines:

- `agent`: native staged review pipeline
- `codex`: Codex CLI-backed review pipeline

Engine is selected by `REVIEW_ENGINE` runtime configuration.

## Agent engine

Agent engine classifies changes and dispatches specialist tasks.

### Review modes

- `skip`: low-risk changes may bypass specialist review
- `light`: minimal specialist checks for low-risk code changes
- `full`: full specialist review for risky or larger changes

### Size policy

`small`/`medium`/`large` thresholds are used by triage to choose mode and token budgets.

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
