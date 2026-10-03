import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyTheme,
  defaultTheme,
  readTheme,
  themeStorageKey,
  writeTheme
} from "../../src/admin/utils/theme.js";

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

describe("theme", () => {
  it("round-trips supported themes", () => {
    stubStorage();

    writeTheme("wise");
    expect(readTheme()).toBe("wise");

    writeTheme("midnight");
    expect(readTheme()).toBe("midnight");
  });

  it("falls back to midnight for missing or invalid values", () => {
    const { map } = stubStorage();

    expect(readTheme()).toBe(defaultTheme);

    map.set(themeStorageKey, "light");
    expect(readTheme()).toBe(defaultTheme);
  });

  it("handles storage failures without throwing", () => {
    stubStorage({
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      }
    });

    expect(readTheme()).toBe(defaultTheme);
    expect(() => writeTheme("wise")).not.toThrow();
  });

  it("applies the theme to the document root", () => {
    const documentElement = { dataset: {} as Record<string, string> };
    vi.stubGlobal("document", { documentElement });

    applyTheme("wise");

    expect(documentElement.dataset.theme).toBe("wise");
  });
});
