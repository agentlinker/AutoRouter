import { existsSync, mkdirSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient } from "../../src/db/client.js";
import { RouteTraceRepository } from "../../src/repositories/routeTraceRepository.js";
import { TraceStore } from "../../src/trace/traceStore.js";

describe("TraceStore", () => {
  const traceDirectory = "/tmp/auto-router-trace-store-test";
  const databasePath = "/tmp/auto-router-trace-store-test/trace.db";

  function createStore(hotRetentionDays = 7) {
    const databaseClient = createDatabaseClient(databasePath);
    return new TraceStore(new RouteTraceRepository(databaseClient.db), {
      hotRetentionDays
    });
  }

  beforeEach(() => {
    if (!existsSync(traceDirectory)) {
      mkdirSync(traceDirectory, { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(traceDirectory, { recursive: true, force: true });
  });

  it("appends and reads the latest trace entry", () => {
    const store = createStore();
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
        privacy_level: "normal",
        context_tokens_est: 12
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
    const store = createStore();
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
        privacy_level: "normal",
        context_tokens_est: 12
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

  it("lists recent traces in reverse chronological order", () => {
    const store = createStore();

    store.append({
      trace_id: "trace-older",
      timestamp: "2026-07-04T10:00:00.000Z",
      session_id: null,
      request: {
        model: "auto",
        normalized_model: "auto/older",
        prompt_hash: "sha256:older",
        stream: false,
        has_tools: false,
        privacy_level: "normal",
        context_tokens_est: 12
      },
      candidates: [],
      filtered: [],
      selected: null,
      policy_hits: [],
      execution: {
        status: "success",
        latency_ms: 10
      },
      cost: {
        estimated_usd: null,
        actual_usd: null,
        price_confidence: "unknown"
      },
      fallbacks: []
    });

    store.append({
      trace_id: "trace-newer",
      timestamp: "2026-07-05T10:00:00.000Z",
      session_id: null,
      request: {
        model: "auto",
        normalized_model: "auto/newer",
        prompt_hash: "sha256:newer",
        stream: false,
        has_tools: false,
        privacy_level: "normal",
        context_tokens_est: 12
      },
      candidates: [],
      filtered: [],
      selected: null,
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
      fallbacks: []
    });

    const traces = store.listRecent(2);

    expect(traces).toHaveLength(2);
    expect(traces[0]?.trace_id).toBe("trace-newer");
    expect(traces[1]?.trace_id).toBe("trace-older");
  });

  it("prunes expired hot traces based on retention days", () => {
    const store = createStore(1);

    store.append({
      trace_id: "trace-old",
      timestamp: "2020-01-01T00:00:00.000Z",
      session_id: null,
      request: {
        model: "auto",
        normalized_model: "auto/old",
        prompt_hash: "sha256:old",
        stream: false,
        has_tools: false,
        privacy_level: "normal",
        context_tokens_est: 1
      },
      candidates: [],
      filtered: [],
      selected: null,
      policy_hits: [],
      execution: {
        status: "success",
        latency_ms: 10
      },
      cost: {
        estimated_usd: null,
        actual_usd: null,
        price_confidence: "unknown"
      },
      fallbacks: []
    });

    store.append({
      trace_id: "trace-current",
      timestamp: new Date().toISOString(),
      session_id: null,
      request: {
        model: "auto",
        normalized_model: "auto/current",
        prompt_hash: "sha256:current",
        stream: false,
        has_tools: false,
        privacy_level: "normal",
        context_tokens_est: 1
      },
      candidates: [],
      filtered: [],
      selected: null,
      policy_hits: [],
      execution: {
        status: "success",
        latency_ms: 10
      },
      cost: {
        estimated_usd: null,
        actual_usd: null,
        price_confidence: "unknown"
      },
      fallbacks: []
    });

    const deleted = store.pruneExpired();
    const traces = store.listRecent(10);

    expect(deleted).toBe(1);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.trace_id).toBe("trace-current");
  });
});
