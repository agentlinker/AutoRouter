import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";

import { buildProviderRegistry } from "../../src/catalog/providerRegistry.js";
import { PriceTable } from "../../src/catalog/priceTable.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { AdapterRegistry } from "../../src/providers/registry.js";
import { StickySessionStore } from "../../src/routing/stickySession.js";
import { createServer } from "../../src/server/createServer.js";
import type { RouterState } from "../../src/state/routerState.js";
import { TraceStore } from "../../src/trace/traceStore.js";
import { createLogger } from "../../src/utils/logger.js";

describe("local smoke", () => {
  let mockAgent: MockAgent;

  beforeEach(() => {
    vi.stubEnv("AUTO_ROUTER_TOKEN", "smoke-token");
    vi.stubEnv("SMOKE_API_KEY", "smoke-api-key");
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await mockAgent.close();
  });

  it("serves health, models, explain, and chat completion together", async () => {
    const pool = mockAgent.get("https://smoke.example.com");
    pool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(200, {
        id: "chatcmpl_smoke",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "smoke-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "smoke ok"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12
        }
      });

    pool
      .intercept({
        path: "/v1/models",
        method: "GET"
      })
      .reply(200, {
        object: "list",
        data: [{ id: "smoke-model", object: "model", owned_by: "smoke" }]
      });

    const config = loadConfig({
      override: {
        platforms: {
          openai: {
            protocol: "openai"
          }
        },
        providers: {
          smoke: {
            display_name: "Smoke",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium"
          }
        },
        endpoints: {
          "smoke-openai": {
            provider: "smoke",
            platform: "openai",
            adapter: "openai_compatible",
            base_url: "https://smoke.example.com/v1",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            }
          }
        },
        accounts: {
          "smoke-account": {
            endpoint: "smoke-openai",
            account_type: "api_key",
            credential_env: "SMOKE_API_KEY"
          }
        },
        models: {
          "smoke-model": {
            endpoint: "smoke-openai",
            model_name: "smoke-model",
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
                account: "smoke-account",
                model: "smoke-model"
              }
            ]
          }
        },
        policies: {
          balanced: {
            min_trust_level: "medium",
            allow_public_only_provider: false,
            fallback_enabled: true,
            sticky_session: true
          }
        }
      }
    });

    const registry = buildProviderRegistry(config);
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
      traceStore: new TraceStore("/tmp/auto-router-smoke-traces")
    };

    const gateway = await createServer(state);

    const healthResponse = await gateway.inject({
      method: "GET",
      url: "/v1/autorouter/health",
      headers: {
        authorization: "Bearer smoke-token"
      }
    });
    expect(healthResponse.statusCode).toBe(200);

    const modelsResponse = await gateway.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer smoke-token"
      }
    });
    expect(modelsResponse.statusCode).toBe(200);

    const chatResponse = await gateway.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer smoke-token"
      },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "hello" }]
      }
    });
    expect(chatResponse.statusCode).toBe(200);

    const explainResponse = await gateway.inject({
      method: "GET",
      url: "/v1/autorouter/explain/latest",
      headers: {
        authorization: "Bearer smoke-token"
      }
    });
    expect(explainResponse.statusCode).toBe(200);

    await gateway.close();
  });
});
