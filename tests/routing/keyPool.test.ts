import { describe, expect, it } from "vitest";

import { selectKeyFromPool, type KeyPoolCandidate } from "../../src/routing/keyPool.js";
import { ActiveRequestTracker } from "../../src/routing/activeRequests.js";
import type { AccountRuntimeState } from "../../src/state/routerState.js";

function makeAccount(id: string, expiresAt?: string | null): AccountRuntimeState {
  return {
    id,
    endpoint_id: "test/ep",
    account_type: "api_key",
    enabled: true,
    available: true,
    recent_error_count: 0,
    expires_at: expiresAt ?? null
  };
}

function makeCandidate(account: AccountRuntimeState, index: number): KeyPoolCandidate {
  return { account, candidateIndex: index };
}

describe("selectKeyFromPool", () => {
  it("returns null for empty pool", () => {
    expect(selectKeyFromPool({
      candidates: [],
      activeCounts: new Map(),
      poolCursors: new Map(),
      poolKey: "p"
    })).toBeNull();
  });

  it("returns the only candidate when pool has one", () => {
    const account = makeAccount("a1");
    const result = selectKeyFromPool({
      candidates: [makeCandidate(account, 0)],
      activeCounts: new Map(),
      poolCursors: new Map(),
      poolKey: "p"
    });
    expect(result?.account.id).toBe("a1");
  });

  it("sorts by expiry ascending, null expiry last", () => {
    const a1 = makeAccount("a1", "2026-12-01T00:00:00Z");
    const a2 = makeAccount("a2", "2026-06-01T00:00:00Z");
    const a3 = makeAccount("a3", null);
    const result = selectKeyFromPool({
      candidates: [makeCandidate(a1, 0), makeCandidate(a2, 1), makeCandidate(a3, 2)],
      activeCounts: new Map(),
      poolCursors: new Map(),
      poolKey: "p"
    });
    // a2 has earlier expiry, should be selected first
    expect(result?.account.id).toBe("a2");
  });

  it("does not filter out expired-configured keys", () => {
    // 已过期的配置时间仍参与排序，不被排除
    const expired = makeAccount("expired", "2020-01-01T00:00:00Z");
    const future = makeAccount("future", "2030-01-01T00:00:00Z");
    const result = selectKeyFromPool({
      candidates: [makeCandidate(future, 0), makeCandidate(expired, 1)],
      activeCounts: new Map(),
      poolCursors: new Map(),
      poolKey: "p"
    });
    // expired has earlier timestamp, should sort first
    expect(result?.account.id).toBe("expired");
  });

  it("prefers least active when expiry is equal", () => {
    const a1 = makeAccount("a1", "2026-06-01T00:00:00Z");
    const a2 = makeAccount("a2", "2026-06-01T00:00:00Z");
    const a3 = makeAccount("a3", "2026-06-01T00:00:00Z");
    const activeCounts = new Map([
      ["a1", 3],
      ["a2", 1],
      ["a3", 2]
    ]);
    const result = selectKeyFromPool({
      candidates: [makeCandidate(a1, 0), makeCandidate(a2, 1), makeCandidate(a3, 2)],
      activeCounts,
      poolCursors: new Map(),
      poolKey: "p"
    });
    expect(result?.account.id).toBe("a2");
  });

  it("uses round-robin cursor when expiry and load are equal", () => {
    const a1 = makeAccount("a1");
    const a2 = makeAccount("a2");
    const a3 = makeAccount("a3");
    const poolCursors = new Map<string, string>();

    // First call: no cursor, should pick first by index
    const first = selectKeyFromPool({
      candidates: [makeCandidate(a1, 0), makeCandidate(a2, 1), makeCandidate(a3, 2)],
      activeCounts: new Map(),
      poolCursors,
      poolKey: "p"
    });
    expect(first?.account.id).toBe("a1");
    expect(poolCursors.get("p")).toBe("a1");

    // Second call: cursor at a1, should pick a2 (after cursor)
    const second = selectKeyFromPool({
      candidates: [makeCandidate(a1, 0), makeCandidate(a2, 1), makeCandidate(a3, 2)],
      activeCounts: new Map(),
      poolCursors,
      poolKey: "p"
    });
    expect(second?.account.id).toBe("a2");
    expect(poolCursors.get("p")).toBe("a2");

    // Third call: cursor at a2, should pick a3
    const third = selectKeyFromPool({
      candidates: [makeCandidate(a1, 0), makeCandidate(a2, 1), makeCandidate(a3, 2)],
      activeCounts: new Map(),
      poolCursors,
      poolKey: "p"
    });
    expect(third?.account.id).toBe("a3");
  });

  it("treats all-null expiry the same for load balancing", () => {
    const a1 = makeAccount("a1", null);
    const a2 = makeAccount("a2", null);
    const activeCounts = new Map([["a1", 5]]);
    const result = selectKeyFromPool({
      candidates: [makeCandidate(a1, 0), makeCandidate(a2, 1)],
      activeCounts,
      poolCursors: new Map(),
      poolKey: "p"
    });
    expect(result?.account.id).toBe("a2");
  });

  it("invalid expiry date sorts as unset", () => {
    const invalid = makeAccount("invalid", "not-a-date");
    const valid = makeAccount("valid", "2026-06-01T00:00:00Z");
    const result = selectKeyFromPool({
      candidates: [makeCandidate(invalid, 0), makeCandidate(valid, 1)],
      activeCounts: new Map(),
      poolCursors: new Map(),
      poolKey: "p"
    });
    // valid date sorts before invalid (which acts as unset)
    expect(result?.account.id).toBe("valid");
  });
});

describe("ActiveRequestTracker", () => {
  it("acquires and releases correctly", () => {
    const tracker = new ActiveRequestTracker();
    expect(tracker.get("a1")).toBe(0);
    tracker.acquire("a1");
    expect(tracker.get("a1")).toBe(1);
    tracker.acquire("a1");
    expect(tracker.get("a1")).toBe(2);
    tracker.release("a1");
    expect(tracker.get("a1")).toBe(1);
    tracker.release("a1");
    expect(tracker.get("a1")).toBe(0);
  });

  it("does not go negative on extra release", () => {
    const tracker = new ActiveRequestTracker();
    tracker.release("a1");
    expect(tracker.get("a1")).toBe(0);
  });

  it("returns previous count on acquire", () => {
    const tracker = new ActiveRequestTracker();
    expect(tracker.acquire("a1")).toBe(0);
    expect(tracker.acquire("a1")).toBe(1);
  });
});
