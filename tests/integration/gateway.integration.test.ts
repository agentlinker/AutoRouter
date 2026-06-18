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

describe("gateway integration", () => {
  const traceDirectory = "/tmp/auto-router-test-traces";
  let mockAgent: MockAgent;

  beforeEach(async () => {
    vi.stubEnv("AUTO_ROUTER_TOKEN", "test-token");
    vi.stubEnv("PRIMARY_API_KEY", "primary-key");
    vi.stubEnv("FALLBACK_API_KEY", "fallback-key");
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await mockAgent.close();
  });

  it("falls back to the second provider and records trace state", async () => {
    const primaryPool = mockAgent.get("https://primary.example.com");
    primaryPool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(429, {
        error: {
          message: "rate limited"
        }
      });

    const fallbackPool = mockAgent.get("https://fallback.example.com");
    fallbackPool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(200, {
        id: "chatcmpl_mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "fallback-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "mock provider response"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      });

    const config = loadConfig({
      override: {
        trace: {
          directory: traceDirectory,
          log_prompts: false
        },
        platforms: {
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
            platform: "primary",
            protocol: "openai_compatible",
            base_url: "https://primary.example.com/v1",
            accounts: [
              {
                id: "primary-account",
                account_type: "api_key",
                api_key_env: "PRIMARY_API_KEY"
              }
            ]
          },
          "fallback-openai": {
            platform: "fallback",
            protocol: "openai_compatible",
            base_url: "https://fallback.example.com/v1",
            accounts: [
              {
                id: "fallback-account",
                account_type: "api_key",
                api_key_env: "FALLBACK_API_KEY"
              }
            ]
          }
        },
        models: {
          auto: {
            policy: "balanced",
            candidates: [
              {
                endpoint: "primary-openai",
                account: "primary-account",
                model: "primary-model"
              },
              {
                endpoint: "fallback-openai",
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
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: new TraceStore(traceDirectory)
    };

    const gateway = await createServer(state);
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        metadata: {
          session_id: "sess-1"
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-auto-router-platform"]).toBe("fallback");
    expect(response.headers["x-auto-router-endpoint"]).toBe("fallback-openai");

    const explain = await gateway.inject({
      method: "GET",
      url: "/v1/auto-router/explain/latest",
      headers: {
        authorization: "Bearer test-token"
      }
    });

    expect(explain.statusCode).toBe(200);
    expect(explain.json().selected.platform).toBe("fallback");
    expect(explain.json().selected.endpoint).toBe("fallback-openai");
    expect(explain.json().fallbacks).toHaveLength(1);

    await gateway.close();
  });

  it("routes successfully through the primary provider", async () => {
    const primaryPool = mockAgent.get("https://success.example.com");
    primaryPool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(200, {
        id: "chatcmpl_success",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "success-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "success"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      });

    const config = loadConfig({
      override: {
        trace: {
          directory: traceDirectory,
          log_prompts: false
        },
        prices: {
          primary: {
            "success-model": {
              input_per_1m: 1,
              output_per_1m: 2,
              source: "manual",
              confidence: "medium"
            }
          }
        },
        platforms: {
          primary: {
            display_name: "Primary",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium"
          }
        },
        endpoints: {
          "primary-openai": {
            platform: "primary",
            protocol: "openai_compatible",
            base_url: "https://success.example.com/v1",
            accounts: [
              {
                id: "primary-account",
                account_type: "api_key",
                api_key_env: "PRIMARY_API_KEY"
              }
            ]
          }
        },
        models: {
          auto: {
            policy: "balanced",
            candidates: [
              {
                endpoint: "primary-openai",
                account: "primary-account",
                model: "success-model"
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
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: new TraceStore(traceDirectory)
    };

    const gateway = await createServer(state);
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        metadata: {
          session_id: "success-session"
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-auto-router-platform"]).toBe("primary");
    expect(response.headers["x-auto-router-endpoint"]).toBe("primary-openai");

    const explain = await gateway.inject({
      method: "GET",
      url: "/v1/auto-router/explain/latest",
      headers: {
        authorization: "Bearer test-token"
      }
    });

    expect(explain.statusCode).toBe(200);
    expect(explain.json().selected.platform).toBe("primary");
    expect(explain.json().selected.endpoint).toBe("primary-openai");

    await gateway.close();
  });

  it("streams provider responses through the gateway", async () => {
    const streamPool = mockAgent.get("https://stream.example.com");
    streamPool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(
        200,
        "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n",
        {
          headers: {
            "content-type": "text/event-stream"
          }
        }
      );

    const config = loadConfig({
      override: {
        trace: {
          directory: traceDirectory,
          log_prompts: false
        },
        platforms: {
          stream: {
            display_name: "Stream",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium"
          }
        },
        endpoints: {
          "stream-openai": {
            platform: "stream",
            protocol: "openai_compatible",
            base_url: "https://stream.example.com/v1",
            accounts: [
              {
                id: "stream-account",
                account_type: "api_key",
                api_key_env: "PRIMARY_API_KEY"
              }
            ]
          }
        },
        models: {
          auto: {
            policy: "balanced",
            candidates: [
              {
                endpoint: "stream-openai",
                account: "stream-account",
                model: "stream-model"
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
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: new TraceStore(traceDirectory)
    };

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
    expect(response.body).toContain("data:");
    expect(response.body).toContain("[DONE]");

    await gateway.close();
  });

  it("filters public-only relays for normal privacy requests", async () => {
    const config = loadConfig({
      override: {
        trace: {
          directory: traceDirectory,
          log_prompts: false
        },
        platforms: {
          relay: {
            display_name: "Relay",
            trust_level: "low",
            privacy_level: "public_only",
            usage_trust: "low"
          }
        },
        endpoints: {
          "relay-openai": {
            platform: "relay",
            protocol: "openai_compatible",
            base_url: "https://relay.example.com/v1",
            accounts: [
              {
                id: "relay-account",
                account_type: "api_key",
                api_key_env: "PRIMARY_API_KEY"
              }
            ]
          }
        },
        models: {
          auto: {
            policy: "balanced",
            candidates: [
              {
                endpoint: "relay-openai",
                account: "relay-account",
                model: "relay-model"
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
    const state: RouterState = {
      config,
      logger: createLogger(),
      platforms: registry.platforms,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: new TraceStore(traceDirectory)
    };

    const gateway = await createServer(state);
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        metadata: {
          privacy_level: "normal"
        }
      }
    });

    expect(response.statusCode).toBe(503);

    await gateway.close();
  });
});
