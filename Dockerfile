# 构建阶段
FROM oven/bun:1 AS builder

WORKDIR /app

# 仅复制与构建相关的文件
COPY package.json bun.lock tsconfig.json ./
COPY src/ ./src/

# 安装依赖并构建
RUN bun install --frozen-lockfile
RUN bun run build

# 运行阶段
FROM oven/bun:1-slim AS runner

WORKDIR /app

# 创建非root用户
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 bunjs

# 仅复制生产所需文件
COPY --from=builder --chown=bunjs:nodejs /app/dist ./dist
COPY --from=builder --chown=bunjs:nodejs /app/package.json ./
COPY --from=builder --chown=bunjs:nodejs /app/bun.lock ./

# 只安装生产依赖
RUN bun install --frozen-lockfile --production

# 切换到非root用户
USER bunjs

# 暴露端口
EXPOSE 3000

# 设置健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

# 设置默认命令
CMD ["bun", "run", "dist/index.js"]
