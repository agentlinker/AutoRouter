import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readSidebarCollapsed,
  sidebarCollapseStorageKey,
  writeSidebarCollapsed
} from "../../src/admin/utils/sidebarCollapse.js";

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
