# ---- Stage 1: Frontend Builder ----
FROM oven/bun:1 AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package.json frontend/bun.lock* ./

RUN bun install --frozen-lockfile

COPY frontend/ .

RUN bun run build


# ---- Stage 2: Backend Builder ----
FROM oven/bun:1 AS backend-builder

WORKDIR /app

COPY package.json bun.lock* ./

RUN bun install --production

COPY src ./src
COPY tsconfig.json .


# ---- Stage 3: Codex CLI Binary ----
FROM debian:bookworm-slim AS codex-downloader

ARG CODEX_VERSION=0.111.0
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "aarch64" || echo "x86_64") && \
    curl -fsSL "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-${ARCH}-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin/ && \
    mv /usr/local/bin/codex-${ARCH}-unknown-linux-musl /usr/local/bin/codex && \
    chmod +x /usr/local/bin/codex


# ---- Stage 4: Production ----
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates ripgrep && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/src ./src
COPY --from=backend-builder /app/package.json .
COPY --from=backend-builder /app/tsconfig.json .

COPY --from=frontend-builder /app/frontend/dist ./public

# Codex CLI binary (statically linked musl build)
COPY --from=codex-downloader /usr/local/bin/codex /usr/local/bin/codex

EXPOSE 5174

CMD ["bun", "run", "start"]
