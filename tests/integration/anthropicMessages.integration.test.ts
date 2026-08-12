import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { MockAgent, setGlobalDispatcher } from "undici";

import { buildProviderRegistry } from "../../src/catalog/providerRegistry.js";
import { PriceTable } from "../../src/catalog/priceTable.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { createDatabaseClient } from "../../src/db/client.js";
import { AdapterRegistry } from "../../src/providers/registry.js";
import { RouteTraceRepository } from "../../src/repositories/routeTraceRepository.js";
import { StickySessionStore } from "../../src/routing/stickySession.js";
import { createServer } from "../../src/server/createServer.js";
import type { RouterState } from "../../src/state/routerState.js";
import { TraceStore } from "../../src/trace/traceStore.js";
import { createLogger } from "../../src/utils/logger.js";

describe("Anthropic Messages compatibility", () => {
  const traceDatabasePath = "/tmp/auto-router-anthropic-messages.db";
  let mockAgent: MockAgent;

  beforeEach(() => {
    vi.stubEnv("AUTO_ROUTER_TOKEN", "test-token");
    vi.stubEnv("UPSTREAM_API_KEY", "upstream-key");
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    rmSync(traceDatabasePath, { force: true });
    await mockAgent.close();
  });

  async function createGateway() {
    const config = loadConfig({
      override: {
        platforms: {
          openai: {
            protocol: "openai"
          }
        },
        providers: {
          demo: {
            display_name: "Demo",
            trust_level: "high",
            privacy_level: "normal",
            usage_trust: "high"
          }
        },
        endpoints: {
          "demo-openai": {
            provider: "demo",
            platform: "openai",
            adapter: "openai_compatible",
            base_url: "https://upstream.example.com/v1",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            }
          }
        },
        accounts: {
          "demo-account": {
            endpoint: "demo-openai",
            account_type: "api_key",
            credential_env: "UPSTREAM_API_KEY"
          }
        },
        models: {
          "demo-claude-opus-5": {
            endpoint: "demo-openai",
            model_name: "claude-opus-5",
            context_window: 1_000_000,
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            }
          }
        }
      }
    });
    const registry = buildProviderRegistry(config);
    const databaseClient = createDatabaseClient(traceDatabasePath);
    const state: RouterState = {
      config,
      logger: createLogger(),
      platforms: registry.platforms,
      providers: registry.providers,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: new TraceStore(new RouteTraceRepository(databaseClient.db))
    };

    return createServer(state);
  }

  function mockTextResponse() {
    mockAgent
      .get("https://upstream.example.com")
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(200, {
        id: "chatcmpl_anthropic_compat",
        model: "claude-opus-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "OK"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 1,
          total_tokens: 13
        }
      });
  }

  it("accepts x-api-key and returns an Anthropic message", async () => {
    mockTextResponse();
    const gateway = await createGateway();
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "test-token",
        "anthropic-version": "2023-06-01"
      },
      payload: {
        model: "claude-opus-5[1m]",
        max_tokens: 32,
        messages: [{ role: "user", content: "Reply exactly OK" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-autorouter-normalized-model"]).toBe("auto/claude-opus-5");
    expect(response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 12,
        output_tokens: 1
      }
    });

    await gateway.close();
  });

  it("wraps the routed result as Anthropic SSE when stream is requested", async () => {
    mockTextResponse();
    const gateway = await createGateway();
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: "Bearer test-token",
        "anthropic-version": "2023-06-01"
      },
      payload: {
        model: "claude-opus-5[1m]",
        max_tokens: 32,
        stream: true,
        messages: [{ role: "user", content: "Reply exactly OK" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: message_start");
    expect(response.body).toContain("\"type\":\"text_delta\",\"text\":\"OK\"");
    expect(response.body).toContain("event: message_stop");

    await gateway.close();
  });
});
