import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isManualRecoveryRequired,
  isRuntimeStatusSchedulable,
  runtimeStatusBadgeClass,
  runtimeStatusDisplayLabel
} from "../../src/admin/runtimeStatusPresentation.js";

describe("runtime status presentation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows expired cooldown as schedulable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));

    const status = {
      runtime_status: "cooling_down",
      status_reason: "upstream_error_cooldown",
      status_cooldown_until: "2026-08-21T16:04:43.293Z"
    };

    expect(isRuntimeStatusSchedulable(status)).toBe(true);
    expect(runtimeStatusBadgeClass(status)).toBe("badge success");
    expect(runtimeStatusDisplayLabel(status)).toBe("可调度");
    expect(isManualRecoveryRequired(status)).toBe(false);
  });

  it("keeps permanent rate limits unavailable", () => {
    const status = {
      runtime_status: "rate_limited",
      status_reason: "rate_limited_permanent"
    };

    expect(isRuntimeStatusSchedulable(status)).toBe(false);
    expect(runtimeStatusBadgeClass(status)).toBe("badge warning");
    expect(runtimeStatusDisplayLabel(status)).toBe("限流中");
    expect(isManualRecoveryRequired(status)).toBe(true);
  });
});
