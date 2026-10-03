import { describe, expect, it } from "vitest";

import { traceFailureAttribution, truncateTraceFailureText } from "../../src/admin/utils/traceFailureReason.js";

describe("trace failure reason presentation", () => {
  it("keeps short text and the truncation boundary intact", () => {
    expect(truncateTraceFailureText("短报错")).toBe("短报错");
    expect(truncateTraceFailureText("a".repeat(120))).toBe("a".repeat(120));
  });

  it("truncates long text without breaking unicode characters", () => {
    const text = "🙂".repeat(121);
    expect(truncateTraceFailureText(text)).toBe("🙂".repeat(120) + "…");
    expect(text).toHaveLength(242);
  });

  it("combines attribution, HTTP status and provider evidence", () => {
    expect(traceFailureAttribution({
      failure_kind: "rate_limit", failure_scope: "account", failure_confidence: "high",
      status_code: 429, provider_code: "quota_exceeded", provider_type: "upstream_error"
    })).toBe("rate_limit · account · high · HTTP 429 · quota_exceeded");
  });

  it("retains partial evidence and handles absent attribution", () => {
    expect(traceFailureAttribution({})).toBe("");
    expect(traceFailureAttribution({ failure_kind: "unknown" })).toBe("unknown · unknown · unknown");
    expect(traceFailureAttribution({ status_code: 503, provider_type: "server_error" })).toBe("HTTP 503 · server_error");
  });
});
