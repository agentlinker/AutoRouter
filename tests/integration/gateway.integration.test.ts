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

describe("gateway integration", () => {
  const traceDirectory = "/tmp/auto-router-test-traces";
  const traceDatabasePath = "/tmp/auto-router-test-traces.db";
  let mockAgent: MockAgent;

  function createTraceStore(databasePath: string) {
    const databaseClient = createDatabaseClient(databasePath);
    return new TraceStore(new RouteTraceRepository(databaseClient.db));
  }

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
    rmSync(traceDatabasePath, { force: true });
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
      traceStore: createTraceStore(traceDatabasePath)
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
    expect(response.headers["x-autorouter-trace-id"]).toBeTruthy();
    expect(response.headers["x-autorouter-normalized-model"]).toBe("auto");

    const explain = await gateway.inject({
      method: "GET",
      url: "/v1/autorouter/explain/latest",
      headers: {
        authorization: "Bearer test-token"
      }
    });

    expect(explain.statusCode).toBe(200);
    expect(explain.json().request.model).toBe("auto");
    expect(explain.json().request.normalized_model).toBe("auto");
    expect(explain.json().selected.platform).toBe("openai");
    expect(explain.json().selected.endpoint).toBe("fallback-openai");
    expect(explain.json().attempts).toEqual([
      expect.objectContaining({
        endpoint: "primary-openai",
        status: "failed",
        error: "rate limited",
        retryable: true
      }),
      expect.objectContaining({
        endpoint: "fallback-openai",
        status: "success"
      })
    ]);
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
          }
        },
        endpoints: {
          "primary-openai": {
            provider: "primary",
            platform: "openai",
            adapter: "openai_compatible",
            base_url: "https://success.example.com/v1",
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
          }
        },
        models: {
          "success-model": {
            endpoint: "primary-openai",
            model_name: "success-model",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            },
            pricing: {
              input_per_1m: 1,
              output_per_1m: 2,
              source: "manual",
              confidence: "medium"
            }
          }
        },
        routes: {
          auto: {
            policy: "balanced",
            candidates: [
              {
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
      providers: registry.providers,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: createTraceStore(traceDatabasePath)
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
    expect(response.headers["x-autorouter-trace-id"]).toBeTruthy();
    expect(response.headers["x-autorouter-normalized-model"]).toBe("auto");

    const explain = await gateway.inject({
      method: "GET",
      url: "/v1/autorouter/explain/latest",
      headers: {
        authorization: "Bearer test-token"
      }
    });

    expect(explain.statusCode).toBe(200);
    expect(explain.json().request.model).toBe("auto");
    expect(explain.json().request.normalized_model).toBe("auto");
    expect(explain.json().selected.platform).toBe("openai");
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
          openai: {
            protocol: "openai"
          }
        },
        providers: {
          stream: {
            display_name: "Stream",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium"
          }
        },
        endpoints: {
          "stream-openai": {
            provider: "stream",
            platform: "openai",
            adapter: "openai_compatible",
            base_url: "https://stream.example.com/v1",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            }
          }
        },
        accounts: {
          "stream-account": {
            endpoint: "stream-openai",
            account_type: "api_key",
            credential_env: "PRIMARY_API_KEY"
          }
        },
        models: {
          "stream-model": {
            endpoint: "stream-openai",
            model_name: "stream-model",
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
      providers: registry.providers,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: createTraceStore(traceDatabasePath)
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
    expect(response.headers["x-autorouter-normalized-model"]).toBe("auto");

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
          openai: {
            protocol: "openai"
          }
        },
        providers: {
          relay: {
            display_name: "Relay",
            trust_level: "low",
            privacy_level: "public_only",
            usage_trust: "low"
          }
        },
        endpoints: {
          "relay-openai": {
            provider: "relay",
            platform: "openai",
            adapter: "openai_compatible",
            base_url: "https://relay.example.com/v1",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            }
          }
        },
        accounts: {
          "relay-account": {
            endpoint: "relay-openai",
            account_type: "api_key",
            credential_env: "PRIMARY_API_KEY"
          }
        },
        models: {
          "relay-model": {
            endpoint: "relay-openai",
            model_name: "relay-model",
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
      providers: registry.providers,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: createTraceStore(traceDatabasePath)
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

  it("routes through the anthropic adapter on a second protocol line", async () => {
    const anthropicPool = mockAgent.get("https://anthropic.example.com");
    anthropicPool
      .intercept({
        path: "/v1/messages",
        method: "POST"
      })
      .reply(200, {
        id: "msg_abc",
        content: [{ type: "text", text: "anthropic ok" }],
        usage: {
          input_tokens: 11,
          output_tokens: 6
        },
        stop_reason: "end_turn"
      });

    const config = loadConfig({
      override: {
        trace: {
          directory: traceDirectory,
          log_prompts: false
        },
        platforms: {
          anthropic: {
            protocol: "anthropic"
          }
        },
        providers: {
          anthropic: {
            display_name: "Anthropic",
            trust_level: "high",
            privacy_level: "normal",
            usage_trust: "high"
          }
        },
        endpoints: {
          "anthropic-messages": {
            provider: "anthropic",
            platform: "anthropic",
            adapter: "anthropic",
            base_url: "https://anthropic.example.com/v1",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: false
            }
          }
        },
        accounts: {
          "anthropic-main": {
            endpoint: "anthropic-messages",
            account_type: "api_key",
            credential_env: "PRIMARY_API_KEY"
          }
        },
        models: {
          "claude-sonnet-direct": {
            endpoint: "anthropic-messages",
            model_name: "claude-sonnet-4-20250514",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: false
            }
          }
        },
        routes: {
          auto: {
            policy: "balanced",
            candidates: [
              {
                account: "anthropic-main",
                model: "claude-sonnet-direct"
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
      traceStore: createTraceStore(traceDatabasePath)
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
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-autorouter-trace-id"]).toBeTruthy();
    expect(response.headers["x-autorouter-normalized-model"]).toBe("auto");

    await gateway.close();
  });

  it("resolves provider/model requests without cross-provider routing", async () => {
    const primaryPool = mockAgent.get("https://provider-model.example.com");
    primaryPool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(200, {
        id: "chatcmpl_provider_model",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-5.5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "provider model ok"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 3,
          total_tokens: 12
        }
      });

    const config = loadConfig({
      override: {
        trace: {
          directory: traceDirectory,
          log_prompts: false
        },
        providers: {
          openrouter: {
            display_name: "OpenRouter",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium",
            protocol: "openai",
            adapter: "openai_compatible",
            base_url: "https://provider-model.example.com/v1",
            accounts: [{ id: "main", credential_env: "PRIMARY_API_KEY" }],
            models: [{ id: "gpt-5-5", model_name: "gpt-5.5" }]
          },
          fallback: {
            display_name: "Fallback",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium",
            protocol: "openai",
            adapter: "openai_compatible",
            base_url: "https://unused.example.com/v1",
            accounts: [{ id: "main", credential_env: "FALLBACK_API_KEY" }],
            models: [{ id: "gpt-5-5", model_name: "gpt-5.5" }]
          }
        },
        routes: {
          auto: {
            policy: "balanced",
            candidates: [{ provider: "fallback", account: "main", model: "gpt-5-5" }]
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
      providers: registry.providers,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: createTraceStore(traceDatabasePath)
    };

    const gateway = await createServer(state);
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        model: "openrouter/gpt-5.5",
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-autorouter-trace-id"]).toBeTruthy();
    expect(response.headers["x-autorouter-normalized-model"]).toBe("openrouter/gpt-5.5");

    await gateway.close();
  });

  it("resolves auto/model requests across providers while keeping the model fixed", async () => {
    const preferredPool = mockAgent.get("https://auto-model.example.com");
    preferredPool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(200, {
        id: "chatcmpl_auto_model",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-5.5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "auto model ok"
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

    const config = loadConfig({
      override: {
        trace: {
          directory: traceDirectory,
          log_prompts: false
        },
        providers: {
          preferred: {
            display_name: "Preferred",
            trust_level: "high",
            privacy_level: "normal",
            usage_trust: "high",
            protocol: "openai",
            adapter: "openai_compatible",
            base_url: "https://auto-model.example.com/v1",
            accounts: [{ id: "main", credential_env: "PRIMARY_API_KEY" }],
            models: [{ id: "gpt-5-5", model_name: "gpt-5.5" }]
          },
          weaker: {
            display_name: "Weaker",
            trust_level: "low",
            privacy_level: "normal",
            usage_trust: "low",
            protocol: "openai",
            adapter: "openai_compatible",
            base_url: "https://unused-auto-model.example.com/v1",
            accounts: [{ id: "main", credential_env: "FALLBACK_API_KEY" }],
            models: [{ id: "gpt-5-5", model_name: "gpt-5.5" }]
          }
        },
        policies: {
          balanced: {
            min_trust_level: "low",
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
      providers: registry.providers,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: createTraceStore(traceDatabasePath)
    };

    const gateway = await createServer(state);
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        model: "auto/gpt-5.5",
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-autorouter-trace-id"]).toBeTruthy();
    expect(response.headers["x-autorouter-normalized-model"]).toBe("auto/gpt-5.5");

    const explain = await gateway.inject({
      method: "GET",
      url: "/v1/autorouter/explain/latest",
      headers: {
        authorization: "Bearer test-token"
      }
    });

    expect(explain.statusCode).toBe(200);
    expect(explain.json().request.model).toBe("auto/gpt-5.5");
    expect(explain.json().request.normalized_model).toBe("auto/gpt-5.5");

    await gateway.close();
  });

  it("resolves bare model names across providers and chooses the highest scored candidate", async () => {
    const preferredPool = mockAgent.get("https://preferred.example.com");
    preferredPool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(200, {
        id: "chatcmpl_bare_model",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-5.5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "bare model ok"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 4,
          total_tokens: 11
        }
      });

    const config = loadConfig({
      override: {
        trace: {
          directory: traceDirectory,
          log_prompts: false
        },
        providers: {
          preferred: {
            display_name: "Preferred",
            trust_level: "high",
            privacy_level: "normal",
            usage_trust: "high",
            protocol: "openai",
            adapter: "openai_compatible",
            base_url: "https://preferred.example.com/v1",
            accounts: [{ id: "main", credential_env: "PRIMARY_API_KEY" }],
            models: [{ id: "gpt-5-5", model_name: "gpt-5.5" }]
          },
          weaker: {
            display_name: "Weaker",
            trust_level: "low",
            privacy_level: "normal",
            usage_trust: "low",
            protocol: "openai",
            adapter: "openai_compatible",
            base_url: "https://weaker.example.com/v1",
            accounts: [{ id: "main", credential_env: "FALLBACK_API_KEY" }],
            models: [{ id: "gpt-5-5", model_name: "gpt-5.5" }]
          }
        },
        policies: {
          balanced: {
            min_trust_level: "low",
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
      providers: registry.providers,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: createTraceStore(traceDatabasePath)
    };

    const gateway = await createServer(state);
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-autorouter-trace-id"]).toBeTruthy();
    expect(response.headers["x-autorouter-normalized-model"]).toBe("auto/gpt-5.5");

    const explain = await gateway.inject({
      method: "GET",
      url: "/v1/autorouter/explain/latest",
      headers: {
        authorization: "Bearer test-token"
      }
    });

    expect(explain.statusCode).toBe(200);
    expect(explain.json().request.model).toBe("gpt-5.5");
    expect(explain.json().request.normalized_model).toBe("auto/gpt-5.5");

    await gateway.close();
  });


  it("returns filtered reasons when no eligible route candidate and records trace", async () => {
    vi.stubEnv("SMALL_API_KEY", "small-key");

    const config = loadConfig({
      override: {
        platforms: {
          openai: {
            protocol: "openai"
          }
        },
        providers: {
          small: {
            display_name: "Small",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium"
          }
        },
        endpoints: {
          "small-openai": {
            provider: "small",
            platform: "openai",
            adapter: "openai_compatible",
            base_url: "https://small.example.com/v1",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            }
          }
        },
        accounts: {
          "small-account": {
            endpoint: "small-openai",
            account_type: "api_key",
            credential_env: "SMALL_API_KEY"
          }
        },
        models: {
          "tiny-model": {
            endpoint: "small-openai",
            model_name: "tiny-model",
            context_window: 100,
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
                account: "small-account",
                model: "tiny-model"
              }
            ]
          }
        },
        policies: {
          balanced: {
            min_trust_level: "low",
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
      providers: registry.providers,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: createTraceStore(traceDatabasePath)
    };

    const gateway = await createServer(state);
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer test-token"
      },
      payload: {
        model: "tiny-model",
        input: "x".repeat(2000),
        stream: false
      }
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.error.code).toBe("endpoint_unavailable");
    expect(body.error.message).toBe("No eligible route candidate");
    expect(Array.isArray(body.error.details?.filtered)).toBe(true);
    expect(body.error.details.filtered[0].reason).toBe("context_window_exceeded");
    expect(body.error.details.context_tokens_est).toBeGreaterThan(100);

    const explain = await gateway.inject({
      method: "GET",
      url: "/v1/autorouter/explain/latest",
      headers: {
        authorization: "Bearer test-token"
      }
    });
    expect(explain.statusCode).toBe(200);
    expect(explain.json().request.model).toBe("tiny-model");
    expect(explain.json().filtered[0].reason).toBe("context_window_exceeded");

    await gateway.close();
  });

});
