import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

import { buildProviderRegistry } from "../../src/catalog/providerRegistry.js";
import { PriceTable } from "../../src/catalog/priceTable.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { createDatabaseClient } from "../../src/db/client.js";
import type { ProviderAdapter, RouteTarget } from "../../src/providers/adapter.js";
import { RouteTraceRepository } from "../../src/repositories/routeTraceRepository.js";
import { StickySessionStore } from "../../src/routing/stickySession.js";
import { createServer } from "../../src/server/createServer.js";
import type { RouterState } from "../../src/state/routerState.js";
import { TraceStore } from "../../src/trace/traceStore.js";
import { createLogger } from "../../src/utils/logger.js";

function createState(input: { adapter: ProviderAdapter; traceDatabasePath: string; traceDirectory: string }): RouterState {
  const config = loadConfig({
    override: {
      trace: {
        directory: input.traceDirectory,
        log_prompts: false
      },
      platforms: {
        openai: {
          protocol: "openai"
        }
      },
      providers: {
        primary: {
          display_name: "Primary",
          trust_level: "medium",
          privacy_level: "normal",
          usage_trust: "medium"
        },
        fallback: {
          display_name: "Fallback",
          trust_level: "medium",
          privacy_level: "normal",
          usage_trust: "medium"
        }
      },
      endpoints: {
        "primary-openai": {
          provider: "primary",
          platform: "openai",
          adapter: "openai_compatible",
          base_url: "https://primary.example.com/v1",
          capabilities: {
            streaming: true,
            tools: true,
            json_mode: true
          }
        },
        "fallback-openai": {
          provider: "fallback",
          platform: "openai",
          adapter: "openai_compatible",
          base_url: "https://fallback.example.com/v1",
          capabilities: {
            streaming: true,
            tools: true,
            json_mode: true
          }
        }
      },
      accounts: {
        "primary-account": {
          endpoint: "primary-openai",
          account_type: "api_key",
          credential_env: "PRIMARY_API_KEY"
        },
        "fallback-account": {
          endpoint: "fallback-openai",
          account_type: "api_key",
          credential_env: "FALLBACK_API_KEY"
        }
      },
      models: {
        "primary-model": {
          endpoint: "primary-openai",
          model_name: "primary-model",
          capabilities: {
            streaming: true,
            tools: true,
            json_mode: true
          }
        },
        "fallback-model": {
          endpoint: "fallback-openai",
          model_name: "fallback-model",
          capabilities: {
            streaming: true,
            tools: true,
            json_mode: true
          }
        }
      },
      routes: {
        auto: {
          policy: "balanced",
          candidates: [
            {
              account: "primary-account",
              model: "primary-model"
            },
            {
              account: "fallback-account",
              model: "fallback-model"
            }
          ]
        }
      },
      policies: {
        balanced: {
          min_trust_level: "medium",
          allow_public_only_provider: false,
          fallback_enabled: true,
          sticky_session: false
        }
      }
    }
  });
  const registry = buildProviderRegistry(config);
  const databaseClient = createDatabaseClient(input.traceDatabasePath);

  return {
    config,
    logger: createLogger(),
    platforms: registry.platforms,
    providers: registry.providers,
    endpoints: registry.endpoints,
    accounts: registry.accounts,
    priceTable: new PriceTable(config),
    adapters: {
      get: () => input.adapter
    } as unknown as RouterState["adapters"],
    stickySessions: new StickySessionStore(),
    traceStore: new TraceStore(new RouteTraceRepository(databaseClient.db))
  };
}

describe("stream fallback boundary", () => {
  const traceDirectory = "/tmp/auto-router-stream-boundary-traces";
  const traceDatabasePath = "/tmp/auto-router-stream-boundary-traces.db";

  beforeEach(() => {
    vi.stubEnv("AUTO_ROUTER_TOKEN", "test-token");
    vi.stubEnv("PRIMARY_API_KEY", "primary-key");
    vi.stubEnv("FALLBACK_API_KEY", "fallback-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(traceDatabasePath, { force: true });
  });

  it("does not fallback chat streams after a chunk has reached the client", async () => {
    const attemptedEndpoints: string[] = [];
    const adapter: ProviderAdapter = {
      type: "openai_compatible",
      async healthCheck() {
        return { status: "healthy" };
      },
      async chatCompletion() {
        throw new Error("not used");
      },
      async *streamChatCompletion(_request, target: RouteTarget) {
        attemptedEndpoints.push(target.endpoint.id);
        if (target.endpoint.id === "primary-openai") {
          yield { raw: "data: primary-partial\n\n" };
          throw new Error("stream disconnected after first token");
        }
        yield { raw: "data: fallback-should-not-run\n\n" };
      }
    };
    const state = createState({ adapter, traceDatabasePath, traceDirectory });
    const gateway = await createServer(state);

    const response = await gateway.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        model: "auto",
        stream: true,
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("primary-partial");
    expect(response.body).not.toContain("fallback-should-not-run");
    expect(attemptedEndpoints).toEqual(["primary-openai"]);

    const explain = await gateway.inject({
      method: "GET",
      url: "/v1/autorouter/explain/latest",
      headers: {
        authorization: "Bearer test-token"
      }
    });
    expect(explain.statusCode).toBe(200);
    expect(explain.json().attempts).toEqual([
      expect.objectContaining({
        endpoint: "primary-openai",
        status: "failed",
        error: "stream disconnected after first token"
      })
    ]);
    expect(explain.json().fallbacks).toEqual([]);

    await gateway.close();
  });

  it("does not fallback native response streams after a chunk has reached the client", async () => {
    const attemptedEndpoints: string[] = [];
    const adapter: ProviderAdapter = {
      type: "openai_compatible",
      async healthCheck() {
        return { status: "healthy" };
      },
      async chatCompletion() {
        throw new Error("not used");
      },
      async responseCompletion() {
        throw new Error("not used");
      },
      async *streamResponse(_request, target: RouteTarget) {
        attemptedEndpoints.push(target.endpoint.id);
        if (target.endpoint.id === "primary-openai") {
          yield { raw: "event: response.output_text.delta\ndata: {\"delta\":\"primary-partial\"}\n\n" };
          throw new Error("responses stream disconnected after first token");
        }
        yield { raw: "event: response.output_text.delta\ndata: {\"delta\":\"fallback-should-not-run\"}\n\n" };
      }
    };
    const state = createState({ adapter, traceDatabasePath, traceDirectory });
    const gateway = await createServer(state);

    const response = await gateway.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        model: "auto",
        stream: true,
        input: "hello"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("primary-partial");
    expect(response.body).not.toContain("fallback-should-not-run");
    expect(attemptedEndpoints).toEqual(["primary-openai"]);

    const explain = await gateway.inject({
      method: "GET",
      url: "/v1/autorouter/explain/latest",
      headers: {
        authorization: "Bearer test-token"
      }
    });
    expect(explain.statusCode).toBe(200);
    expect(explain.json().attempts).toEqual([
      expect.objectContaining({
        endpoint: "primary-openai",
        status: "failed",
        error: "responses stream disconnected after first token"
      })
    ]);
    expect(explain.json().fallbacks).toEqual([]);

    await gateway.close();
  });
});
