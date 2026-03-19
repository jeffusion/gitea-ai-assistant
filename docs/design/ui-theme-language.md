# UI Theme Language（亮/暗双主题统一规范）

## 目标

- 保证浅色/深色主题视觉一致、可读性稳定。
- 避免组件直接写死颜色，防止后续开发样式漂移。
- 让新增页面默认遵循同一套语义化设计语言。

## 三层设计语言模型

1. **Primitive（原子值）**：HSL 基础值，仅在全局 token 定义处出现。
2. **Semantic（语义 token）**：`background`、`foreground`、`success`、`danger` 等，按语义命名。
3. **Component（组件 token）**：组件只能消费语义 token，不允许跨层引用原子值。

## 当前项目的主题基线

主题定义文件：`frontend/src/index.css`

- 基础语义：`background`、`foreground`、`card`、`muted`、`border`、`ring`
- 状态语义：`success`、`warning`、`danger`、`info`
- 补充语义：`surface-muted`、`surface-elevated`、`surface-overlay`、`text-subtle`、`text-soft`、`border-soft`

Tailwind 语义映射：`frontend/tailwind.config.js`

- 已将语义 token 映射为可直接使用的 class（如 `bg-success/10`、`text-danger`、`border-info/20`）。

### 主色方案（当前）

- 主色选择：**Cobalt Blue（钴蓝）**，兼顾 light/dark 的对比度与品牌辨识度。
- Light：`--primary: 224 76% 52%`，`--primary-foreground: 0 0% 100%`
- Dark：`--primary: 224 88% 68%`，`--primary-foreground: 224 40% 12%`
- 焦点环：`--ring` 与 `--primary` 保持同色，确保交互一致性。
- 设计理由：亮色下避免过“脏”或偏绿感；暗色下提升明度保证可见性，同时用深色前景保证主按钮文字对比。

## 可选整套主题色方案（社区开源复用）

> 要求：切换的是**整套语义 token**，不是只改 `primary`。

当前支持四套（统一冷调科技风）：

1. `cobalt`（默认）
   - 本项目当前默认冷色科技风（自定义）。
2. `zinc`
   - 来源：shadcn/ui themes（MIT）
   - 参考：<https://github.com/shadcn-ui/ui/blob/main/apps/v4/public/r/themes.css>
3. `nord`
   - 来源：Nord（MIT）
   - 参考：<https://github.com/nordtheme/nord>
4. `tokyo-night`
   - 来源：Tokyo Night（Apache-2.0）
   - 参考：<https://github.com/folke/tokyonight.nvim>

实现方式：

- `cobalt` 作为内置基础主题，直接由 `:root` / `.dark` 提供默认 token。
- 其余方案（`zinc|nord|tokyo-night`）通过 `data-palette` 覆盖：
  - `:root[data-palette='*']` 覆盖浅色 token
  - `.dark[data-palette='*']` 覆盖暗色 token
- 在根节点写入 `data-palette`（`cobalt|zinc|nord|tokyo-night`）。
- 组件侧不改业务 class，继续消费语义 token。

## 页面风格骨架（社区方案落地）

> 目标：即使切换配色，页面结构、密度、层级、动效仍保持统一。

本项目采用了三类社区成熟范式，并映射到本仓库 utility：

1. **4px 节奏与密度系统（shadcn/仪表盘实践）**
   - 基础节奏按 4px 递进，主内容区使用 `theme-page-content`（统一宽度 + 留白节奏）。
   - 卡片内部与卡片间距默认采用 `p-6 / gap-6` 级别，避免页面“块状松散或拥挤”。
2. **三层深度系统（卡片/悬浮/遮罩）**
   - 统一卡片外观：`theme-card-shell` + `theme-card-header` + `theme-card-content`。
   - 交互抬升统一：`theme-interactive-elevate`（轻微位移 + 阴影，不做夸张动效）。
   - 页面壳层统一：`theme-shell-gradient` + `theme-sticky-bar`。
3. **可控动效系统（Linear/Vercel 风格）**
   - Hover/按钮反馈优先短时平滑动效，避免大幅动画导致“廉价感”。
   - 表单输入统一 `theme-input-surface`，状态条与统计胶囊统一 `theme-control-pill`。

参考来源：

- shadcn/ui themes 与组件风格实践（MIT）：<https://github.com/shadcn-ui/ui>
- Vercel Dashboard 设计迭代思路：<https://vercel.com/changelog/dashboard-navigation-redesign-rollout>
- Nord / Tokyo Night 社区配色体系：
  - <https://github.com/nordtheme/nord>
  - <https://github.com/folke/tokyonight.nvim>

## 强制规则（必须遵守）

1. **禁止在业务 TSX 中使用硬编码暗色类**：如 `bg-zinc-*`、`text-zinc-*`、`border-white/10`（历史 UI 基础组件逐步迁移，不作为新增业务代码例外）。
2. **禁止在组件内写死颜色值**：如 `rgba(...)`、`#xxxxxx`、`rgb(...)`。
3. **状态色统一语义化**：成功/警告/错误/信息统一用 `success|warning|danger|info`。
4. **弹窗/卡片/表格优先使用语义表面色**：`card`、`muted`、`popover`、`background`。
5. **交互阴影统一工具类**：`theme-glow-primary|success|warning|danger`。
6. **普通 hover 反馈禁止用主色背景**：非主操作控件统一使用 `hover:bg-accent*` 或 `hover:bg-muted*`，避免亮色主题出现重色块。

## 推荐 class 使用方式

- 文字层级：`text-foreground` / `text-muted-foreground`
- 面板层级：`bg-card` / `bg-muted/50` / `bg-popover`
- 边框层级：`border-border` / `theme-border-soft`
- 状态展示：`text-success`、`bg-danger/10`、`border-warning/30`
- 普通交互 hover：`hover:bg-accent/60`、`hover:bg-accent`、`hover:bg-muted/60`
- 主操作 hover：仅主按钮可用 `hover:bg-primary/90`
- 顶部吸附操作栏：`theme-sticky-bar`
- 页面骨架：`theme-page-frame` / `theme-page-actions` / `theme-page-content`
- 卡片骨架：`theme-card-shell` / `theme-card-header` / `theme-card-content`
- 弹窗骨架：`theme-dialog-panel` / `theme-dialog-header` / `theme-dialog-body` / `theme-dialog-footer`
- 错误态容器：`theme-error-panel`
- 模态遮罩：`theme-surface-overlay`

## 页面级统一约束（防止布局风格漂移）

1. 页面容器优先使用 `theme-page-frame`，避免每个页面自行定义高度和底部间距。
2. 顶部操作区统一使用 `theme-sticky-bar + theme-page-actions`，避免按钮栏视觉断层。
3. 主内容区统一使用 `theme-page-content`，确保横向节奏和留白一致。
4. 标准业务卡片统一使用 `theme-card-shell/header/content`，避免同类卡片出现不同边框/背景层级。
5. 错误提示统一使用 `theme-error-panel`，保持状态反馈视觉语言一致。

## destructive 与 danger 的约定

- `destructive`：保留给 shadcn 组件内置 destructive 变体语义。
- `danger`：业务状态语义（报错、失败、风险提示）统一使用。
- 新业务组件优先使用 `danger`，避免 `destructive/danger` 混用造成漂移。

## 新功能开发检查清单

- [ ] 页面在 light/dark 下均可读（文本、边框、状态色有对比度）
- [ ] 无 `zinc/white` 等暗色硬编码 class
- [ ] 无内联 `style` 颜色值
- [ ] 状态色全部使用语义 token
- [ ] 组件未绕过语义层直接访问原子颜色
- [ ] `bun run ui:visual` 通过（light/dark 关键页面视觉回归）

## 视觉基线截图回归（Playwright）

- 生成/更新基线：`bun run ui:visual:update`
- 校验基线一致性：`bun run ui:visual`
- 轻量 UI 全链路：`bun run ui:regression && bun run ui:visual`

约定：

1. PR 默认运行 `ui:visual`，出现 diff 必须人工确认是“预期视觉变更”。
2. 只有在确认设计变更成立时，才执行 `ui:visual:update` 更新基线并提交快照。
3. 不允许在未更新设计规范的情况下大量更新视觉基线，避免把漂移“固化为正确”。
4. 基线快照以 Linux CI 环境为准（当前为 `*-linux.png`），避免跨系统更新导致快照噪声。

## 迁移策略

当新增模块时，按以下顺序处理：

1. 先补充语义 token（如确有新语义，而不是新颜色）。
2. 在 Tailwind 映射语义 token。
3. 在组件中只消费语义 class。
4. 最后做 light/dark 视觉回归。
