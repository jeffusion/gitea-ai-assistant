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


# ---- Stage 3: Production ----
FROM oven/bun:1-slim

WORKDIR /app

COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/src ./src
COPY --from=backend-builder /app/package.json .
COPY --from=backend-builder /app/tsconfig.json .

COPY --from=frontend-builder /app/frontend/dist ./public

EXPOSE 3000

CMD ["bun", "run", "start"]
