import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_BODY_LIMIT_BYTES } from "../../src/config/schema.js";
import { loadConfig } from "../../src/config/loadConfig.js";

describe("loadConfig", () => {
  it("normalizes provider-centered shorthand into internal runtime shape", () => {
    const config = loadConfig({
      override: {
        providers: {
          demo: {
            display_name: "Demo",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium",
            protocol: "openai",
            adapter: "openai_compatible",
            base_url: "https://example.com/v1",
            accounts: [
              {
                id: "main",
                credential_env: "DEMO_API_KEY"
              }
            ],
            models: [
              {
                id: "chat",
                model_name: "gpt-test",
                context_window: 128000
              }
            ]
          }
        },
        routes: {
          auto: {
            policy: "balanced",
            candidates: [
              {
                provider: "demo",
                account: "main",
                model: "chat"
              }
            ]
          }
        },
        policies: {
          balanced: {
            min_trust_level: "medium",
            sticky_session: true,
            weights: {
              cost: 1.2,
              quality: 0.8
            }
          }
        }
      }
    });

    expect(config.platforms.openai.protocol).toBe("openai");
    expect(config.providers.demo.display_name).toBe("Demo");
    expect(config.endpoints["demo/default"].provider).toBe("demo");
    expect(config.accounts["demo/main"].endpoint).toBe("demo/default");
    expect(config.models["demo/chat"].model_name).toBe("gpt-test");
    expect(config.routes.auto.candidates[0].account).toBe("demo/main");
    expect(config.routes.auto.candidates[0].model).toBe("demo/chat");
    expect(config.policies.balanced.thresholds.min_trust_level).toBe("medium");
    expect(config.policies.balanced.weights.cost).toBe(1.2);
    expect(config.policies.balanced.weights.sticky).toBe(1);
  });

  it("defaults server.body_limit_bytes to ~2M-token budget (8 MiB)", () => {
    const config = loadConfig({
      override: {
        providers: {},
        routes: {},
        policies: {
          balanced: {
            min_trust_level: "low"
          }
        }
      }
    });

    expect(config.server.body_limit_bytes).toBe(DEFAULT_SERVER_BODY_LIMIT_BYTES);
    expect(config.server.body_limit_bytes).toBe(8 * 1024 * 1024);
  });

  it("accepts an explicit server.body_limit_bytes override", () => {
    const config = loadConfig({
      override: {
        server: {
          body_limit_bytes: 1024
        },
        providers: {},
        routes: {},
        policies: {
          balanced: {
            min_trust_level: "low"
          }
        }
      }
    });

    expect(config.server.body_limit_bytes).toBe(1024);
  });

  it("normalizes legacy OpenRouter-style pricing keys", () => {
    const config = loadConfig({
      override: {
        platforms: {
          openai: {
            protocol: "openai"
          }
        },
        providers: {
          demo: {
            display_name: "Demo"
          }
        },
        endpoints: {
          "demo/default": {
            provider: "demo",
            platform: "openai",
            adapter: "openai_compatible",
            base_url: "https://example.com/v1"
          }
        },
        accounts: {},
        models: {
          "demo/grok-4.5": {
            endpoint: "demo/default",
            model_name: "grok-4.5",
            pricing: {
              input: 3,
              output: 15,
              cacheRead: 0.75,
              cacheWrite: 3.75,
              source: "openrouter",
              confidence: "medium"
            }
          }
        },
        routes: {},
        policies: {
          balanced: {
            min_trust_level: "low"
          }
        }
      }
    });

    expect(config.models["demo/grok-4.5"].pricing).toMatchObject({
      input_per_1m: 3,
      output_per_1m: 15,
      cached_input_per_1m: 0.75,
      source: "openrouter",
      confidence: "medium"
    });
  });
});
