import { existsSync, mkdirSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TraceStore } from "../../src/trace/traceStore.js";

describe("TraceStore", () => {
  const traceDirectory = "/tmp/auto-router-trace-store-test";

  beforeEach(() => {
    if (!existsSync(traceDirectory)) {
      mkdirSync(traceDirectory, { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(traceDirectory, { recursive: true, force: true });
  });

  it("appends and reads the latest trace entry", () => {
    const store = new TraceStore(traceDirectory);
    const trace = {
      trace_id: "trace-1",
      timestamp: new Date().toISOString(),
      session_id: "sess-1",
      request: {
        model: "auto",
        normalized_model: "auto",
        prompt_hash: "sha256:abc",
        stream: false,
        has_tools: false,
        privacy_level: "normal"
      },
      candidates: [
        {
          endpoint: "primary-openai",
          platform: "primary",
          account: "acc-1",
          model: "model-a"
        }
      ],
      filtered: [],
      selected: {
        endpoint: "primary-openai",
        platform: "primary",
        account_hash: "sha256:acc",
        model: "model-a"
      },
      policy_hits: ["session_sticky"],
      execution: {
        status: "success" as const,
        latency_ms: 10
      },
      cost: {
        estimated_usd: null,
        actual_usd: null,
        price_confidence: "unknown" as const
      },
      fallbacks: []
    };

    store.append(trace);

    const latest = store.latest();
    expect(latest?.trace_id).toBe("trace-1");
    expect(latest?.request.prompt_hash).toBe("sha256:abc");
    expect(latest?.request.normalized_model).toBe("auto");
    expect(latest?.policy_hits).toContain("session_sticky");
    expect(latest?.execution.status).toBe("success");
    expect(JSON.stringify(latest)).not.toContain("hello world");
  });

  it("keeps secret-like values out of trace payloads when not explicitly written", () => {
    const store = new TraceStore(traceDirectory);
    const trace = {
      trace_id: "trace-2",
      timestamp: new Date().toISOString(),
      session_id: null,
      request: {
        model: "auto",
        normalized_model: "auto",
        prompt_hash: "sha256:def",
        stream: false,
        has_tools: false,
        privacy_level: "normal"
      },
      candidates: [],
      filtered: [],
      selected: null,
      policy_hits: [],
      execution: {
        status: "failed" as const,
        latency_ms: 5,
        error: "provider_auth_failed"
      },
      cost: {
        estimated_usd: null,
        actual_usd: null,
        price_confidence: "unknown" as const
      },
      fallbacks: []
    };

    store.append(trace);
    const latest = store.latest();

    expect(JSON.stringify(latest)).not.toContain("sk-live");
    expect(JSON.stringify(latest)).not.toContain("Bearer ");
  });
});
