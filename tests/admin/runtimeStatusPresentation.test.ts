import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatRouteStatusDetail,
  isManualRecoveryRequired,
  isRuntimeStatusSchedulable,
  runtimeStatusBadgeClass,
  runtimeStatusDisplayLabel,
  runtimeObservationDisplayLabel,
  runtimeObservationErrorMessage
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

  it("shows expired observation cooldown as unverified and retryable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00Z"));

    expect(runtimeObservationDisplayLabel({
      runtime_status: "cooling_down",
      status_reason: "upstream_error_cooldown",
      status_cooldown_until: "2026-08-21T16:04:43.293Z"
    })).toBe("未验证（可尝试）");

    expect(runtimeObservationDisplayLabel({
      runtime_status: "cooling_down",
      status_reason: "upstream_error_cooldown",
      status_cooldown_until: "2026-08-22T00:04:43.293Z"
    })).toBe("冷却中");
  });

  it("labels an expired cooldown error as historical", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));

    const message = "system memory overloaded (current: 93.0%, threshold: 90%)";

    expect(runtimeObservationErrorMessage({
      runtime_status: "cooling_down",
      status_reason: "upstream_error_cooldown",
      status_message: message,
      status_cooldown_until: "2026-08-12T14:41:44Z"
    })).toBe(`最近错误：${message}`);

    expect(runtimeObservationErrorMessage({
      runtime_status: "cooling_down",
      status_reason: "upstream_error_cooldown",
      status_message: message,
      status_cooldown_until: "2026-09-01T00:04:43Z"
    })).toBe(`错误信息：${message}`);
  });

  it("indents every line of a multiline unavailable reason", () => {
    expect(formatRouteStatusDetail(
      "Anthropic",
      [
        "鉴权异常",
        "异常码: auth_failed",
        "错误信息: invalid API key"
      ].join("\n"),
      ""
    )).toBe([
      "• Anthropic: 鉴权异常",
      "  ◦ 异常码: auth_failed",
      "  ◦ 错误信息: invalid API key"
    ].join("\n"));
  });
});
