# ---- Stage 1: Frontend Builder ----
FROM oven/bun:1 AS frontend-builder

WORKDIR /app/frontend

# 拷贝前端的 package.json 和 lockfile
COPY frontend/package.json frontend/bun.lock ./

# 安装前端依赖
RUN bun install --frozen-lockfile

# 拷贝所有前端代码
COPY frontend/ .

# 构建前端静态文件
RUN bun run build


# ---- Stage 2: Backend Builder ----
FROM oven/bun:1 AS backend-builder

WORKDIR /app

# 拷贝后端的 package.json 和 lockfile
COPY package.json bun.lock ./

# 只安装生产环境依赖
RUN bun install --frozen-lockfile --production

# 拷贝所有后端代码
COPY src ./src
COPY tsconfig.json .


# ---- Stage 3: Production ----
FROM oven/bun:1-slim

WORKDIR /app

# 从后端构建器拷贝依赖和代码
COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/src ./src
COPY --from=backend-builder /app/package.json .
COPY --from=backend-builder /app/tsconfig.json .

# 从前端构建器拷贝构建好的静态文件到 public 目录
COPY --from=frontend-builder /app/frontend/dist ./public

EXPOSE 3000

# 启动服务
CMD ["bun", "run", "start"]
