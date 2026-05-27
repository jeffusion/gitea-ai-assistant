# Contributing

## Development setup

- **Runtime**: [Bun](https://bun.sh) >= 1.2.5
- **Backend**: Hono (TypeScript)
- **Frontend**: React + Vite + Tailwind CSS
- **Database**: SQLite (via Drizzle ORM)

```bash
bun install                       # install all dependencies
bun run dev                       # start dev server with hot reload
```

## Code quality

```bash
bun run lint                      # lint backend + frontend
bun test                          # backend unit tests
cd frontend && bun test           # frontend unit tests
bun run build                     # build backend
cd frontend && bun run build      # build frontend
E2E_MOCK_LLM=1 bun run test:e2e  # E2E with mock LLM (no real provider needed)
```

Run all checks before pushing:

```bash
bun run lint && bun run build && bun test && cd frontend && bun run build && bun test
```

## Pull requests

1. Fork the repository and create a feature branch from `main`
2. Make your changes with clear, atomic commits
3. Ensure all quality checks pass (lint, build, test)
4. Open a PR against `main` with a concise description of the change and motivation

### Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): subject

feat(review): add size-based routing
fix(webhook): handle missing signature header
chore(deps): bump hono to 4.x
docs(config): update env variable table
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`.

## UI development conventions

The frontend follows a three-layer design token model:

1. **Primitive** — HSL base values, defined only in global CSS tokens
2. **Semantic** — `background`, `foreground`, `success`, `danger`, etc.
3. **Component** — Components consume semantic tokens only. Direct primitive references are forbidden

### Theme definition

- Theme file: `frontend/src/index.css`
- Tailwind mapping: `frontend/tailwind.config.js`
- Primary palette: **Cobalt Blue**, with light/dark variants tuned for contrast

Available palette presets (`data-palette` attribute): `cobalt` (default), `zinc`, `nord`, `tokyo-night`.

### Hard rules

- **No hardcoded dark-theme classes** in business TSX: `bg-zinc-*`, `text-zinc-*`, `border-white/10`, etc.
- **No inline color values**: `rgba(...)`, `#xxxxxx`, `rgb(...)`
- **Status colors use semantic tokens**: `success` / `warning` / `danger` / `info`
- **Panels use semantic surface tokens**: `card`, `muted`, `popover`, `background`
- **Interactive glow** uses utility classes: `theme-glow-primary|success|warning|danger`
- **Non-primary hover** uses `hover:bg-accent*` or `hover:bg-muted*`. Only primary buttons may use `hover:bg-primary/90`

### Recommended class patterns

| Context | Classes |
|---|---|
| Text | `text-foreground` / `text-muted-foreground` |
| Panel | `bg-card` / `bg-muted/50` / `bg-popover` |
| Border | `border-border` / `theme-border-soft` |
| Status | `text-success` / `bg-danger/10` / `border-warning/30` |
| Hover (non-primary) | `hover:bg-accent/60` / `hover:bg-muted/60` |
| Hover (primary action) | `hover:bg-primary/90` |
| Page frame | `theme-page-frame` / `theme-page-actions` / `theme-page-content` |
| Card | `theme-card-shell` / `theme-card-header` / `theme-card-content` |
| Dialog | `theme-dialog-panel` / `theme-dialog-header` / `theme-dialog-body` / `theme-dialog-footer` |
| Error state | `theme-error-panel` |
| Sticky bar | `theme-sticky-bar` |
| Input surface | `theme-input-surface` |
| Control pill | `theme-control-pill` |

### `destructive` vs `danger`

- `destructive` — reserved for shadcn built-in destructive variant semantics
- `danger` — business status semantics (errors, failures, risk indicators)

New business components should prefer `danger` to avoid drift.

### Pre-merge checklist

- [ ] Page renders correctly in both light and dark themes
- [ ] No `zinc`/`white` hardcoded dark-theme classes
- [ ] No inline `style` color values
- [ ] All status colors use semantic tokens
- [ ] Components do not bypass the semantic layer to access primitive colors
- [ ] `bun run ui:visual` passes (light/dark visual regression)

### Visual regression

- Generate/update baseline: `bun run ui:visual:update`
- Verify baseline consistency: `bun run ui:visual`
- Full UI check: `bun run ui:regression && bun run ui:visual`

Baseline snapshots use Linux CI environment (`*-linux.png`). Cross-system snapshot updates introduce noise and should be avoided.
