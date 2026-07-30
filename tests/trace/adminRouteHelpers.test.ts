import { describe, expect, it } from "vitest";

import { serializeTrace } from "../../src/server/routes/adminRouteHelpers.js";
import type { RuntimeSnapshot } from "../../src/runtime/runtimeTypes.js";
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
    candidates: [
      {
        route_id: "candidate-1",
        endpoint: "yxxb/default",
        platform: "openai",
        provider: "yxxb",
        account: "yxxb/default/sub-yxxb-eu-cc",
        model_id: "yxxb/grok-4.5",
        model: "grok-4.5",
        score: 0.92
      }
    ],
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
  it("exposes provider api key hints for selected and candidate accounts", () => {
    const snapshot = {
      accounts: [
        {
          id: "yxxb/default/sub-yxxb-eu-cc",
          endpoint_id: "yxxb/default",
          provider_key: "yxxb",
          endpoint_key: "default",
          account_key: "sub-yxxb-eu-cc",
          api_key_hint: "...16e4",
          account_type: "api_key",
          enabled: true,
          available: true,
          recent_error_count: 0
        }
      ]
    } as RuntimeSnapshot;

    const result = serializeTrace(traceWithSelectedAccountHash(), snapshot);

    expect(result.selected_account_hash).toBe("sha256:selected-account");
    expect(result.selected_api_key).toBe("...16e4");
    expect(result.candidates[0]?.api_key).toBe("...16e4");
  });
});
