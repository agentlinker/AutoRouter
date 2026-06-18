import { describe, expect, it } from "vitest";

import { StickySessionStore } from "../../src/routing/stickySession.js";

describe("StickySessionStore", () => {
  it("stores and returns routes by session id", () => {
    const store = new StickySessionStore();
    store.set("sess-1", {
      endpointId: "openrouter-openai",
      accountId: "main",
      model: "claude-sonnet"
    });

    expect(store.get("sess-1")).toEqual({
      endpointId: "openrouter-openai",
      accountId: "main",
      model: "claude-sonnet"
    });
    expect(store.get("missing")).toBeNull();
  });
});
