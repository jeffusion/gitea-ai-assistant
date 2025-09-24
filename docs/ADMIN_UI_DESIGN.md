# Gitea AI Assistant 后台管理页面设计方案

## 1. 总体目标

构建一个简单、安全的后台管理界面，允许管理员浏览 Gitea 上的代码仓库，并为选定的仓库一键“开启”或“关闭” AI 代码审查的 Webhook。此功能旨在替代当前繁琐的手动配置过程，简化新项目的接入流程。

## 2. 技术选型

- **后端增强**: 继续使用 **Hono** 框架，在现有应用中开辟一组新的 API 路由。
- **前端框架**: **React (Vite + TypeScript)**，用于快速构建现代化交互界面。
- **UI 组件库**: **shadcn/ui** 配合 **Tailwind CSS**，以实现专业且美观的界面。
- **状态管理**: **React Query (TanStack Query)**，用于高效管理服务器状态和数据缓存。
- **认证机制**: **JSON Web Tokens (JWT)**，实现安全无状态的登录认证。

## 3. 架构设计

采用前后端分离的架构。

- **后端 (Backend)**:
  - 在 Hono 应用中新增路由组 `/admin/api`，提供 RESTful API。
  - 通过一个新的管理员级别 Gitea Token 与 Gitea API 交互，该 Token 需具备读写仓库和 Webhook 的权限。
  - 所有 `/admin/api` 路由都将受到 JWT 中间件的保护。

- **前端 (Frontend)**:
  - 在项目根目录创建新的 `frontend` 文件夹，存放所有前端代码。
  - 前端为单页面应用 (SPA)，负责登录、展示仓库列表和提供 Webhook 管理操作。

- **部署 (Deployment)**:
  - 采用多阶段 `Dockerfile` 进行构建。
  - 第一阶段构建前端静态文件。
  - 第二阶段构建后端服务。
  - 最终镜像将前端静态文件集成到后端服务中，由 Hono 统一提供服务，实现单容器部署。
  - 相应更新 `kubernetes.yaml.template` 文件。

## 4. 核心功能模块设计

### A. 认证流程

1.  **访问**: 用户访问管理页面，若无本地有效 JWT，则跳转至登录页。
2.  **登录**: 用户输入在环境变量中配置的 `ADMIN_PASSWORD`。
3.  **验证**: 前端调用 `POST /admin/api/login`，后端验证密码。
4.  **Token 生成**: 验证成功后，后端使用 `JWT_SECRET` 生成一个有时效性的 JWT 并返回给前端。
5.  **存储**: 前端将 JWT 存储在 `localStorage` 中。
6.  **请求**: 后续所有对 `/admin/api` 的请求均在 `Authorization` 请求头中携带 `Bearer <token>`。

### B. 后端 API 设计 (`/admin/api`)

- **`POST /admin/api/login`** (公开)
  - **功能**: 用户登录。
  - **请求体**: `{ password: "..." }`
  - **响应**: `{ token: "jwt_token" }` 或认证失败错误。

- **`GET /admin/api/repositories`** (需认证)
  - **功能**: 获取 Gitea 实例上管理员可见的所有仓库列表，并附带其 Webhook 状态。
  - **逻辑**: 调用 Gitea API 获取仓库列表，并对每个仓库检查是否存在由本应用创建的 Webhook。
  - **返回**: `[{ name: "owner/repo", webhook_status: "active" | "inactive" }]`

- **`POST /admin/api/repositories/{owner}/{repo}/webhook`** (需认证)
  - **功能**: 为指定仓库创建 AI Review 的 Webhook。
  - **逻辑**: 调用 Gitea API 创建 Webhook，目标 URL 指向本服务的 `/api/webhook`。
  - **返回**: `{ success: true }`

- **`DELETE /admin/api/repositories/{owner}/{repo}/webhook`** (需认证)
  - **功能**: 删除为 AI Review 创建的 Webhook。
  - **逻辑**: 调用 Gitea API 查找并删除与本服务相关的 Webhook。
  - **返回**: `{ success: true }`

### C. 前端页面设计

- **登录页**: 一个居中的表单，包含密码输入框和“登录”按钮。
- **管理主页 (Dashboard)**:
  - 顶部标题和刷新按钮。
  - 仓库列表，支持按名称搜索/筛选。
  - 列表项包括：
    - 仓库名称 (`owner/repo`)。
    - Webhook 状态标识 (例如，彩色的图标和文字)。
    - 操作按钮 (例如，“启用”或“停用”)。

## 5. 环境变量配置

需要新增以下环境变量：

- `ADMIN_PASSWORD`: 后台管理页面的登录密码。
- `JWT_SECRET`: 用于签发和验证 JWT 的密钥。
- `GITEA_ADMIN_TOKEN`: 一个拥有 Gitea 管理权限的 Token，用于 API 调用。

## 6. 实施步骤规划

1.  **项目初始化**: 创建 `frontend` 目录并初始化 Vite (React+TS) 项目，配置 UI 库。
2.  **后端开发**: 实现 `/admin/api` 路由组，包括登录、JWT 中间件和 Webhook 管理逻辑。
3.  **前端开发**: 创建登录页和管理主页，实现与后端 API 的交互。
4.  **容器化**: 更新 `Dockerfile` 为多阶段构建，并调整 `kubernetes.yaml.template`。
5.  **文档更新**: 在 `README.md` 中说明新功能的使用和配置方法。
