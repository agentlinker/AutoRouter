export type ThemeId = "midnight" | "wise";

export const themeStorageKey = "autorouter_admin_theme";
export const defaultTheme: ThemeId = "midnight";

const themeValues: ReadonlySet<string> = new Set<ThemeId>(["midnight", "wise"]);

export function isThemeId(value: string | null): value is ThemeId {
  return value !== null && themeValues.has(value);
}

export function readTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    return isThemeId(stored) ? stored : defaultTheme;
  } catch {
    return defaultTheme;
  }
}

export function writeTheme(theme: ThemeId): void {
  try {
    localStorage.setItem(themeStorageKey, theme);
  } catch {
    // 主题切换仍在当前会话生效，持久化失败不阻断页面。
  }
}

export function applyTheme(theme: ThemeId): void {
  const root = (
    globalThis as typeof globalThis & {
      document?: { documentElement: { dataset: Record<string, string> } };
    }
  ).document?.documentElement;

  if (!root) {
    return;
  }

  root.dataset.theme = theme;
}
