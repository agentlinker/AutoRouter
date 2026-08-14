# Admin 侧边栏收起 — 设计

日期：2026-08-15
状态：已确认，待实现

## 目标

Admin 控制台侧边栏（`.sidebar`，固定 264px）支持收起为图标条，把横向空间让给内容区。收起状态跨刷新保留。

## 已确认的取舍

| 决策点 | 结论 | 理由 |
|---|---|---|
| 收起形态 | 图标条常驻，68px | 导航始终可点，不引入浮层 hover 时序问题 |
| 触发按钮位置 | 侧边栏底部 | `.sidebar` 已是 `grid-template-rows: auto 1fr auto`，第三行为空槽位；两态下按钮不跳位 |
| 持久化 | `localStorage` | 用户明确要求跨刷新保留 |
| 窄屏（≤1040px） | 不启用 | 该断点下侧边栏已变为顶部导航，另做移动端交互不属于本次范围 |
| 实现方式 | React state + CSS 类切换，持久化抽为纯函数模块 | 纯 CSS 方案读不到 localStorage；Context / 全局 store 目前只有一个消费者，属 YAGNI |

被排除的方案：纯 CSS checkbox hack（无法持久化）、图标条 + hover 浮出完整菜单（交互细节与本次体量不匹配）、引入 Context 或 zustand（无第二个消费者）。

## 组件与状态

**`src/admin/utils/sidebarCollapse.ts`（新增）**

集中 storage key 与安全读写：

- `sidebarCollapseStorageKey = "autorouter_admin_sidebar_collapsed"`（与现有 `autorouter_admin_token` 保持同一命名风格）
- `readSidebarCollapsed(): boolean`
- `writeSidebarCollapsed(collapsed: boolean): void`

存储值用 `"1"` / `"0"`。

**`src/admin/components/Sidebar.tsx`（新增）**

从 `providers.tsx` 抽出侧边栏 JSX。Props：

- `items` — 导航配置（沿用现有 `navItems`）
- `collapsed: boolean`
- `onToggle: () => void`

底部切换按钮用 `PanelLeftClose` / `PanelLeftOpen`（lucide-react），带 `aria-label` 与 `title`。

**`src/admin/routes/providers.tsx`（修改）**

`AdminRoot` 保留状态所有权，因为它渲染整个 `.console-shell`：

- 挂载时以 `readSidebarCollapsed()` 作为 `useState` 初始值
- 切换时更新 state 并调用 `writeSidebarCollapsed`
- 按状态给 `.console-shell` 加 `sidebar-collapsed` 类
- 侧边栏 JSX 替换为 `<Sidebar />`

抽出 `Sidebar.tsx` 是因为本次改动正好落在这段 JSX 上，且 `providers.tsx` 已 2260 行、混杂 8 个 provider 页面。不涉及其他文件的重构。

## 样式

展开态样式不改，只增加收起态覆盖规则。

- `.console-shell` 列宽改为变量驱动：`grid-template-columns: var(--sidebar-w, 264px) minmax(0, 1fr)`
- `.console-shell.sidebar-collapsed` 将 `--sidebar-w` 设为 `68px`
- 收起态下：
  - `.sidebar` padding `24px 18px` → `20px 10px`，内容居中
  - `.sidebar-brand` 仅保留 `.brand-mark`，`strong` / `span` 设 `display: none`，底部分割线保留
  - `.nav-item` 改为 `justify-content: center`，`span` 隐去，只剩 17px 图标
  - `.nav-item.active` 的横向渐变改为整块方形高亮（窄条上横向渐变视觉偏斜）
  - 底部切换按钮同样图标居中
- 过渡：仅 `grid-template-columns` 加 `transition: 200ms ease`；文字用 `display: none` 直接消失，不做淡出（68px 宽度内会挤出换行）。`@media (prefers-reduced-motion: reduce)` 下关闭过渡
- 名称提示：收起态给 `.nav-item` 加原生 `title`，用系统 tooltip，不自建浮层
- 窄屏：收起态规则包在 `@media (min-width: 1041px)` 内，与现有 `max-width: 1040px` 断点严格互补；`≤1040px` 时切换按钮 `display: none`

宽度取 68px 而非 64px：图标 17px，两侧需保留可点击区域与 10px padding，68px 使方形高亮块呈正方。

## 数据流

```
挂载 → readSidebarCollapsed() → useState 初始值
点按钮 → setCollapsed(next) → writeSidebarCollapsed(next)
                            └→ .console-shell 类名切换 → CSS 重排
```

状态仅存在于 `AdminRoot`，不进 URL、不进 TanStack Query、不涉及后端。切换是纯客户端操作，无请求，因此无 loading 或失败中间态。

## 错误处理

`localStorage` 在隐私模式或配额满时会抛异常。读写均包 `try/catch`：

- 读失败，或值不是 `"1"` / `"0"` → 返回 `false`（展开），作为安全默认值
- 写失败 → 静默忽略；当次会话内收起仍生效，仅不跨刷新

不打 `console.error`，不提示用户。侧边栏宽度未能记住不值得打扰用户，这是有意的取舍。

## 测试

`tests/admin/sidebarCollapse.test.ts`，纯函数单测，`vi.stubGlobal` 造 `localStorage`：

1. 写入 `true` 后读回 `true`；写入 `false` 后读回 `false`
2. key 不存在时返回 `false`
3. 值为垃圾数据（`"yes"` / `""`）时返回 `false`
4. `getItem` 抛异常时返回 `false` 且不向外抛
5. `setItem` 抛异常时不向外抛

不写组件渲染与 CSS 布局的自动化测试：项目未安装 jsdom / testing-library，为单个侧边栏引入整套 DOM 测试栈不划算。这部分由 `npm run dev` 手工验证：

- 展开 / 收起切换
- 刷新后状态保持
- 窄屏（≤1040px）切换按钮消失，顶部导航行为不变
- 键盘 Tab 可聚焦切换按钮

提交前验证：`npm run typecheck && npm test`

## 改动清单

| 文件 | 变更 |
|---|---|
| `src/admin/utils/sidebarCollapse.ts` | 新增，storage 读写 |
| `src/admin/components/Sidebar.tsx` | 新增，从 `providers.tsx` 抽出 + 收起支持 |
| `src/admin/routes/providers.tsx` | 抽走侧边栏 JSX，加 state 与类名 |
| `src/admin/styles.css` | 宽度变量 + 收起态规则 |
| `tests/admin/sidebarCollapse.test.ts` | 新增 |
| `.gitignore` | 加 `.superpowers/`（已完成） |
