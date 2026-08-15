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
 * 写失败时静默忽略：当次会话内收起仍然生效，不需要打扰用户。
 */
export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(sidebarCollapseStorageKey, collapsed ? collapsedValue : expandedValue);
  } catch {
    // 忽略：宽度记不住不影响功能
  }
}
