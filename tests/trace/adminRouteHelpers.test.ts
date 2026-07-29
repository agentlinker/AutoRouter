import { describe, expect, it } from "vitest";

import { serializeTrace } from "../../src/server/routes/adminRouteHelpers.js";
import type { RouteTrace } from "../../src/trace/traceTypes.js";

function traceWithSelectedAccountHash(): RouteTrace {
  return {
    trace_id: "trace-account",
    timestamp: "2026-07-28T00:00:00.000Z",
    session_id: null,
    request: {
      model: "auto",
      normalized_model: "auto",
      prompt_hash: "sha256:prompt",
      stream: false,
      has_tools: false,
      privacy_level: "normal",
      context_tokens_est: 10
    },
    candidates: [],
    filtered: [],
    selected: {
      route_id: "auto",
      endpoint: "yxxb/default",
      platform: "openai",
      provider: "yxxb",
      account_hash: "sha256:selected-account",
      model_id: "yxxb/grok-4.5",
      model: "grok-4.5",
      score: 1
    },
    policy_hits: [],
    execution: {
      status: "success",
      latency_ms: 12
    },
    cost: {
      estimated_usd: null,
      actual_usd: null,
      price_confidence: "unknown"
    },
    attempts: [],
    fallbacks: [],
    feedback: null
  };
}

describe("serializeTrace", () => {
  it("exposes the selected account hash without the raw account id", () => {
    const result = serializeTrace(traceWithSelectedAccountHash());

    expect(result.selected_account_hash).toBe("sha256:selected-account");
    expect(JSON.stringify(result)).not.toContain("yxxb/default/sub-yxxb-eu-cc");
  });
});
