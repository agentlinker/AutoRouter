# Admin 侧边栏收起 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin 控制台侧边栏支持收起为 68px 图标条，收起状态通过 `localStorage` 跨刷新保留。

**Architecture:** `AdminRoot` 持有 `collapsed` state 并给 `.console-shell` 加 `sidebar-collapsed` 类，CSS 用 `--sidebar-w` 变量驱动列宽。侧边栏 JSX 抽成独立 `Sidebar` 组件，`localStorage` 读写抽成纯函数模块以便单测。窄屏（≤1040px）不启用收起。

**Tech Stack:** React 19、TanStack Router（`Link` + `activeProps`）、lucide-react 图标、纯 CSS（无 CSS-in-JS / 无 Tailwind）、Vitest。

**设计文档：** `docs/superpowers/specs/2026-08-15-sidebar-collapse-design.md`

---

## 关键背景（实现者必读）

这个仓库的约定，违反了会构建失败或 review 打回：

1. **相对导入必须带 `.js` 后缀**，即使源文件是 `.ts` / `.tsx`。写 `from "../utils/sidebarCollapse.js"`，不是 `"../utils/sidebarCollapse"`。
2. **注释用中文，命名用英文。** 注释要简洁，只解释「为什么」，不复述代码。
3. ESM + TypeScript strict。
4. Admin 前端源码在 `src/admin/`，样式集中在单个 `src/admin/styles.css`（1440 行，没有 CSS Module，没有 styled-components）。
5. 测试用 Vitest，没有独立配置文件。Admin 的纯函数测试放 `tests/admin/`，现有唯一样例是 `tests/admin/traceAccountHash.test.ts`（12 行，直接 import 纯函数断言）。
6. **项目没有装 jsdom / testing-library**，跑不了组件渲染测试。本计划只对纯函数写自动化测试，UI 靠手工验证（Task 6）。
7. 提交前验证组合固定为 `npm run typecheck && npm test`。`npm run typecheck` 会同时校验后端 tsconfig 和 `tsconfig.admin.json`（admin tsx）。

**当前侧边栏的实际结构**（`src/admin/routes/providers.tsx:486-516`，`AdminRoot` 的 return 里）：

```tsx
  return (
    <main className="console-shell">
      <aside className="sidebar">
        <div className="brand sidebar-brand">
          <div className="brand-mark">
            <Cpu size={21} />
          </div>
          <div>
            <strong>AutoRouter</strong>
            <span>Control Plane</span>
          </div>
        </div>

        <nav className="side-nav" aria-label="Admin navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.label}
                to={item.to}
                className="nav-item"
                activeProps={{ className: "nav-item active" }}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

      </aside>

      <section className="workspace">
```

注意 `</nav>` 和 `</aside>` 之间有一个空行——`.sidebar` 的 CSS 是 `grid-template-rows: auto 1fr auto`，第三行槽位现在是空的，收起按钮就放这里。

`navItems` 定义在 `src/admin/routes/providers.tsx:328-385`，是 `as const` 的数组，8 项，每项形如：

```ts
  {
    label: "Providers",
    icon: Network,
    to: "/providers",
    title: "Provider 管理",
    description: "配置不同协议的 Provider，自动整理可用模型。"
  },
```

`icon` 是 lucide-react 组件，`title` / `description` 给 `.page-header` 用（`AdminRoot` 里的 `activeNavItem`），侧边栏只用 `label` / `icon` / `to`。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/admin/utils/sidebarCollapse.ts` | 新建。`localStorage` 读写 + 容错。唯一被单测覆盖的模块。 |
| `src/admin/components/Sidebar.tsx` | 新建。侧边栏展示组件，无状态（受控），props 传 `items` / `collapsed` / `onToggle`。 |
| `src/admin/routes/providers.tsx` | 修改。`AdminRoot` 加 state、渲染 `<Sidebar>`、删掉原侧边栏 JSX；导出 `navItems` 的类型。 |
| `src/admin/styles.css` | 修改。`--sidebar-w` 变量 + `@media (min-width: 1041px)` 内的收起态规则。 |
| `tests/admin/sidebarCollapse.test.ts` | 新建。5 个用例覆盖读写与异常。 |

拆 `Sidebar.tsx` 的理由：`providers.tsx` 已 2260 行、混了 8 个 provider 页面组件，本次改动正好落在侧边栏这段 JSX 上。不动其他部分。

---

### Task 1: sidebarCollapse 工具模块

**Files:**
- Create: `src/admin/utils/sidebarCollapse.ts`
- Test: `tests/admin/sidebarCollapse.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/admin/sidebarCollapse.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readSidebarCollapsed,
  sidebarCollapseStorageKey,
  writeSidebarCollapsed
} from "../../src/admin/utils/sidebarCollapse.js";

/** 造一个最小的 localStorage 替身，可注入抛异常的实现 */
function stubStorage(overrides: Partial<Storage> = {}) {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: () => null,
    length: 0,
    ...overrides
  } as Storage;

  vi.stubGlobal("localStorage", storage);
  return { storage, map };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sidebarCollapse", () => {
  it("round-trips collapsed state", () => {
    stubStorage();

    writeSidebarCollapsed(true);
    expect(readSidebarCollapsed()).toBe(true);

    writeSidebarCollapsed(false);
    expect(readSidebarCollapsed()).toBe(false);
  });

  it("defaults to expanded when nothing is stored", () => {
    stubStorage();

    expect(readSidebarCollapsed()).toBe(false);
  });

  it("treats unexpected stored values as expanded", () => {
    const { map } = stubStorage();

    map.set(sidebarCollapseStorageKey, "yes");
    expect(readSidebarCollapsed()).toBe(false);

    map.set(sidebarCollapseStorageKey, "");
    expect(readSidebarCollapsed()).toBe(false);
  });

  it("returns expanded when reading throws", () => {
    stubStorage({
      getItem: () => {
        throw new Error("storage disabled");
      }
    });

    expect(readSidebarCollapsed()).toBe(false);
  });

  it("swallows write failures", () => {
    stubStorage({
      setItem: () => {
        throw new Error("quota exceeded");
      }
    });

    expect(() => writeSidebarCollapsed(true)).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/admin/sidebarCollapse.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/admin/utils/sidebarCollapse.js"`

- [ ] **Step 3: 写最小实现**

创建 `src/admin/utils/sidebarCollapse.ts`：

```ts
// 与 autorouter_admin_token 保持同一命名风格
export const sidebarCollapseStorageKey = "autorouter_admin_sidebar_collapsed";

const collapsedValue = "1";
const expandedValue = "0";

/**
 * 读取侧边栏收起状态。
 * 隐私模式下 localStorage 可能不可用，读不到或值异常时一律按展开处理。
 */
export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(sidebarCollapseStorageKey) === collapsedValue;
  } catch {
    return false;
  }
}

/**
 * 持久化侧边栏收起状态。
 * 写失败（配额满、隐私模式）时静默忽略：当次会话内收起仍然生效，只是不跨刷新，
 * 不值得为此打扰用户。
 */
export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(sidebarCollapseStorageKey, collapsed ? collapsedValue : expandedValue);
  } catch {
    // 忽略：宽度记不住不影响功能
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/admin/sidebarCollapse.test.ts
```

Expected: PASS，5 passed

- [ ] **Step 5: 提交**

```bash
git add src/admin/utils/sidebarCollapse.ts tests/admin/sidebarCollapse.test.ts
git commit -m "feat: add sidebar collapse persistence helpers"
```

---

### Task 2: 抽出 Sidebar 组件（不改行为）

先做纯搬迁，收起能力在 Task 3 加。这样万一样式或结构搬错了，`git diff` 能立刻看出来。

**Files:**
- Create: `src/admin/components/Sidebar.tsx`
- Modify: `src/admin/routes/providers.tsx`（`navItems` 附近加类型导出；`AdminRoot` 的 return 换成 `<Sidebar>`）

- [ ] **Step 1: 创建 Sidebar 组件**

创建 `src/admin/components/Sidebar.tsx`：

```tsx
import { Link } from "@tanstack/react-router";
import { Cpu, type LucideIcon } from "lucide-react";

type SidebarRoute =
  | "/providers"
  | "/catalog"
  | "/api-keys"
  | "/usage"
  | "/trace"
  | "/tokens"
  | "/policies"
  | "/settings";

export interface SidebarNavItem {
  label: string;
  icon: LucideIcon;
  to: SidebarRoute;
}

export interface SidebarProps {
  items: readonly SidebarNavItem[];
}

export function Sidebar(props: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand sidebar-brand">
        <div className="brand-mark">
          <Cpu size={21} />
        </div>
        <div className="sidebar-brand-text">
          <strong>AutoRouter</strong>
          <span>Control Plane</span>
        </div>
      </div>

      <nav className="side-nav" aria-label="Admin navigation">
        {props.items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.label}
              to={item.to}
              className="nav-item"
              activeProps={{ className: "nav-item active" }}
            >
              <Icon size={17} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
```

注意两处相对原代码的差异，都是刻意的：
- 品牌文字外层 `<div>` 加了 `sidebar-brand-text` 类，收起态要靠它整块隐藏（原来是无类名的裸 `div`，CSS 选不中）。
- `to={item.to}` 的类型：`navItems` 是 `as const`，`to` 会被推成字面量联合类型，赋给 `string` 是安全的。TanStack Router 的 `Link` 接受 `string`，类型校验在 Step 4 确认。

- [ ] **Step 2: 在 providers.tsx 里替换掉原侧边栏 JSX**

在 `src/admin/routes/providers.tsx` 顶部 import 区，`import { AppDialog } from "../components/Dialog.js";` 这行后面加一行：

```ts
import { Sidebar } from "../components/Sidebar.js";
```

然后把 `AdminRoot` 里从 `<aside className="sidebar">` 到 `</aside>`（含其间空行）整段替换为：

```tsx
      <Sidebar items={navItems} />
```

替换后 `AdminRoot` 的 return 开头应该是：

```tsx
  return (
    <main className="console-shell">
      <Sidebar items={navItems} />

      <section className="workspace">
```

- [ ] **Step 3: 清理不再使用的 import**

`Cpu` 在 `providers.tsx` 里还有别处用到（auth 页的 `.auth-brand`，约 436 行 `<Cpu size={22} />`），**不要删**。`Link` 也仍被其他 provider 页面使用，不要删。

跑一次确认没有未使用的 import：

```bash
npm run typecheck
```

Expected: 无输出（成功）。若报 `'X' is declared but its value is never read`，删掉对应 import 再跑。

- [ ] **Step 4: 手工确认 UI 无变化**

```bash
npm run dev
```

浏览器打开 `http://127.0.0.1:8811/admin`，输入 admin token 进入。确认侧边栏和改动前完全一致：品牌区、8 个导航项、当前页高亮。然后 `Ctrl-C` 停掉。

- [ ] **Step 5: 提交**

```bash
git add src/admin/components/Sidebar.tsx src/admin/routes/providers.tsx
git commit -m "refactor: extract admin Sidebar component"
```

---

### Task 3: Sidebar 支持收起（组件层）

**Files:**
- Modify: `src/admin/components/Sidebar.tsx`

- [ ] **Step 1: 加 collapsed / onToggle props 与底部按钮**

把 `src/admin/components/Sidebar.tsx` 整个文件替换为：

```tsx
import { Link } from "@tanstack/react-router";
import { Cpu, PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";

export interface SidebarNavItem {
  label: string;
  icon: LucideIcon;
  to: string;
}

export interface SidebarProps {
  items: readonly SidebarNavItem[];
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar(props: SidebarProps) {
  const toggleLabel = props.collapsed ? "展开侧边栏" : "收起侧边栏";
  const ToggleIcon = props.collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <aside className="sidebar">
      <div className="brand sidebar-brand">
        <div className="brand-mark">
          <Cpu size={21} />
        </div>
        <div className="sidebar-brand-text">
          <strong>AutoRouter</strong>
          <span>Control Plane</span>
        </div>
      </div>

      <nav className="side-nav" aria-label="Admin navigation">
        {props.items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.label}
              to={item.to}
              className="nav-item"
              activeProps={{ className: "nav-item active" }}
              // 收起态只剩图标，靠原生 tooltip 显示名称
              title={props.collapsed ? item.label : undefined}
            >
              <Icon size={17} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <button
          className="sidebar-toggle"
          type="button"
          aria-label={toggleLabel}
          aria-expanded={!props.collapsed}
          title={toggleLabel}
          onClick={props.onToggle}
        >
          <ToggleIcon size={17} />
          <span>收起</span>
        </button>
      </div>
    </aside>
  );
}
```

按钮里的 `<span>收起</span>` 在收起态由 CSS 隐藏，展开态显示为「收起」。图标本身已经表达了方向（`PanelLeftClose` / `PanelLeftOpen`），所以文字不需要跟着变。

- [ ] **Step 2: 更新调用方**

`src/admin/routes/providers.tsx` 里 `<Sidebar items={navItems} />` 现在缺 props，`npm run typecheck` 会报错。这是预期的——Task 4 补上。先确认报错内容符合预期：

```bash
npm run typecheck
```

Expected: FAIL，报 `Property 'collapsed' is missing` / `Property 'onToggle' is missing`

- [ ] **Step 3: 不提交，直接进 Task 4**

组件和调用方要一起才能编译通过，Task 4 结束时一并提交。

---

### Task 4: AdminRoot 接状态

**Files:**
- Modify: `src/admin/routes/providers.tsx`

- [ ] **Step 1: import 工具模块**

在 `src/admin/routes/providers.tsx` 的 import 区，`import { Sidebar } from "../components/Sidebar.js";` 后面加：

```ts
import { readSidebarCollapsed, writeSidebarCollapsed } from "../utils/sidebarCollapse.js";
```

`useState` 已经从 `react` 引入过了（第 26 行 `import { useEffect, useMemo, useState } from "react";`），不用改。

- [ ] **Step 2: 在 AdminRoot 里加 state 与切换函数**

在 `AdminRoot` 里，紧跟现有的 `const [authError, setAuthError] = useState<string | null>(null);` 之后加一行：

```tsx
  // 惰性初始化：localStorage 只在首次挂载时读一次
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
```

然后在 `AdminRoot` 内已有的 `function lockConsole() { ... }` 之后加：

```tsx
  function toggleSidebar() {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeSidebarCollapsed(next);
      return next;
    });
  }
```

- [ ] **Step 3: 给 console-shell 加类名并传 props**

把 `AdminRoot` return 里的这两行：

```tsx
    <main className="console-shell">
      <Sidebar items={navItems} />
```

改成：

```tsx
    <main className={`console-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <Sidebar items={navItems} collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
```

- [ ] **Step 4: 确认编译通过、测试通过**

```bash
npm run typecheck && npm test
```

Expected: typecheck 无输出；vitest 全绿（含 Task 1 的 5 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/admin/components/Sidebar.tsx src/admin/routes/providers.tsx
git commit -m "feat: add sidebar collapse toggle state"
```

此时功能上已经能切换，但还没有收起态样式，点按钮只会让文字消失/出现（因为 CSS 还没写）。Task 5 补样式。

---

### Task 5: 收起态样式

**Files:**
- Modify: `src/admin/styles.css`

- [ ] **Step 1: 把 console-shell 列宽改成变量驱动**

找到 `src/admin/styles.css:156-160`：

```css
.console-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr);
}
```

替换为：

```css
.console-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: var(--sidebar-w, 264px) minmax(0, 1fr);
  transition: grid-template-columns 200ms ease;
}
```

- [ ] **Step 2: 给品牌文字包裹层和底部区加基础样式**

`.sidebar-brand span` 规则（`src/admin/styles.css:186-191`）之后插入：

```css
.sidebar-brand-text {
  min-width: 0;
}

.sidebar-footer {
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.sidebar-toggle {
  width: 100%;
  height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 0 11px;
  background: rgba(15, 23, 42, 0.66);
  color: #a8b3c7;
  cursor: pointer;
}

.sidebar-toggle:hover {
  border-color: var(--line-strong);
  background: rgba(14, 165, 233, 0.1);
  color: #dbeafe;
}

/* 与 .switch-control 的焦点环保持一致 */
.sidebar-toggle:focus-visible {
  outline: 2px solid rgba(125, 211, 252, 0.78);
  outline-offset: 2px;
}
```

`.sidebar-footer` 落在 `.sidebar` 的 `grid-template-rows: auto 1fr auto` 第三行——那个槽位本来就是空的，不用改 grid 定义。

- [ ] **Step 3: 加收起态规则**

在同一文件的 `.settings-row { display: contents; }`（约 1345 行）之后、`@media (max-width: 1040px)` 之前插入：

```css
/* 收起态只在桌面布局生效：≤1040px 时侧边栏已变成顶部导航，另有一套规则 */
@media (min-width: 1041px) {
  .console-shell.sidebar-collapsed {
    --sidebar-w: 68px;
  }

  .sidebar-collapsed .sidebar {
    padding: 20px 10px;
    justify-items: center;
  }

  .sidebar-collapsed .sidebar-brand {
    padding: 0 0 14px;
    justify-content: center;
  }

  /* 68px 宽度放不下品牌文字，直接移除而不是淡出，避免挤出换行 */
  .sidebar-collapsed .sidebar-brand-text {
    display: none;
  }

  .sidebar-collapsed .brand-mark {
    width: 40px;
    height: 40px;
  }

  .sidebar-collapsed .side-nav {
    width: 100%;
    justify-items: center;
  }

  .sidebar-collapsed .nav-item {
    width: 42px;
    justify-content: center;
    padding: 0;
  }

  .sidebar-collapsed .nav-item span {
    display: none;
  }

  /* 展开态是横向渐变，压到 42px 方块里会显得偏斜，收起态换成均匀底色 */
  .sidebar-collapsed .nav-item.active {
    background: rgba(56, 189, 248, 0.16);
  }

  .sidebar-collapsed .sidebar-footer {
    width: 100%;
    display: grid;
    justify-items: center;
  }

  .sidebar-collapsed .sidebar-toggle {
    width: 42px;
    justify-content: center;
    padding: 0;
  }

  .sidebar-collapsed .sidebar-toggle span {
    display: none;
  }
}

/* 窄屏用顶部导航，收起按钮无意义 */
@media (max-width: 1040px) {
  .sidebar-footer {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .console-shell {
    transition: none;
  }
}
```

`@media (max-width: 1040px)` 这块是**新增的独立块**，不要塞进文件里已有的那个 `@media (max-width: 1040px)`——那个块紧接在后面，两个同断点的块并存是合法的，且新增块只管 `.sidebar-footer` 一件事，读起来更清楚。

- [ ] **Step 4: 手工验证桌面态**

```bash
npm run dev
```

打开 `http://127.0.0.1:8811/admin` 并登录，浏览器窗口保持宽于 1041px，逐条确认：

1. 底部有「收起」按钮，点一下侧边栏收窄成图标条，内容区变宽
2. 收起态下 8 个图标垂直排列居中，当前页图标有高亮底色
3. hover 图标出现系统 tooltip 显示页面名（如 `Providers`）
4. 按钮图标从 `PanelLeftClose` 变成 `PanelLeftOpen`，点一下能展开回 264px
5. 收起态下点任一图标能正常跳转，跳转后仍保持收起

- [ ] **Step 5: 提交**

```bash
git add src/admin/styles.css
git commit -m "feat: style collapsed admin sidebar rail"
```

---

### Task 6: 完整验证

**Files:** 无改动，只验证。

- [ ] **Step 1: 跑完整验证组合**

```bash
npm run typecheck && npm test
```

Expected: typecheck 无输出；vitest 全部通过。

- [ ] **Step 2: 验证持久化**

`npm run dev` 后在浏览器里：

1. 收起侧边栏
2. 刷新页面（Cmd-R）
3. 确认刷新后仍是收起态
4. 展开侧边栏，再刷新，确认是展开态

- [ ] **Step 3: 验证窄屏**

把浏览器窗口拖窄到 1040px 以下（或用 DevTools 响应式模式设成 900px）：

1. 侧边栏变成顶部导航（现有行为）
2. 「收起」按钮不可见
3. 即使之前存的是收起态，顶部导航也照常显示全部文字
4. 拖回宽屏，之前的收起状态恢复

- [ ] **Step 4: 验证键盘可达性**

在宽屏展开态下，从地址栏按 Tab 逐个聚焦：

1. 能 Tab 到「收起」按钮，聚焦时有可见轮廓
2. 按 Enter 或 Space 能触发收起
3. 收起态下仍能 Tab 到该按钮并展开回来

- [ ] **Step 5: 验证降低动效偏好**

macOS：系统设置 → 辅助功能 → 显示 → 勾选「减弱动态效果」。回到页面点收起，确认宽度是瞬间变化而非 200ms 过渡。验证完可以取消勾选。

- [ ] **Step 6: 确认工作区干净**

```bash
git status --short
```

Expected: 不出现 `src/admin/` 或 `tests/admin/` 下的未提交改动。（`src/routing/` 等其他文件的既有改动与本次无关，保持原样。）

---

## 自检记录

**Spec 覆盖：**

| 设计文档章节 | 对应任务 |
|---|---|
| `sidebarCollapse.ts` 读写 + storage key | Task 1 |
| `Sidebar.tsx` 组件与 props | Task 2（搬迁）+ Task 3（收起能力） |
| `AdminRoot` 状态所有权、类名切换 | Task 4 |
| `--sidebar-w` 变量、68px、padding / brand / nav-item / active / 按钮收起态 | Task 5 Step 1-3 |
| 200ms 过渡 + `prefers-reduced-motion` | Task 5 Step 1、Step 3 |
| 原生 `title` tooltip | Task 3 Step 1（`title={props.collapsed ? item.label : undefined}`） |
| 窄屏不启用（`min-width: 1041px` 互补断点、按钮隐藏） | Task 5 Step 3、Task 6 Step 3 |
| 错误处理：读失败 / 值异常 → `false`；写失败静默 | Task 1 Step 3 实现 + Step 1 的用例 4、5 |
| 5 个单测用例 | Task 1 Step 1 |
| 手工验证清单（切换 / 持久化 / 窄屏 / 键盘） | Task 6 |
| `.gitignore` 加 `.superpowers/` | 已在 commit `12343f8` 完成 |

**类型一致性：** `readSidebarCollapsed` / `writeSidebarCollapsed` / `sidebarCollapseStorageKey` 在 Task 1 定义，Task 4 与测试中的引用名一致。`SidebarProps` 的 `items` / `collapsed` / `onToggle` 在 Task 3 定义，Task 4 传参一致。CSS 类名 `sidebar-collapsed` / `sidebar-brand-text` / `sidebar-footer` / `sidebar-toggle` 在 Task 3-5 之间一致。
