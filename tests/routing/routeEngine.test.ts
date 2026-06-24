import { describe, expect, it, vi } from "vitest";

import { ModelCatalog } from "../../src/catalog/modelCatalog.js";
import { PriceTable } from "../../src/catalog/priceTable.js";
import { buildProviderRegistry } from "../../src/catalog/providerRegistry.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { selectRoute } from "../../src/routing/routeEngine.js";
import { HttpError } from "../../src/utils/httpErrors.js";

function buildBaseConfig() {
  return {
    platforms: {
      openai: {
        protocol: "openai"
      }
    },
    providers: {
      openrouter: {
        display_name: "OpenRouter",
        trust_level: "medium",
        privacy_level: "normal",
        usage_trust: "medium"
      }
    },
    endpoints: {
      "openrouter-openai": {
        provider: "openrouter",
        platform: "openai",
        adapter: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        capabilities: {
          streaming: true,
          tools: true,
          json_mode: true
        }
      }
    },
    accounts: {
      "openrouter-main": {
        endpoint: "openrouter-openai",
        account_type: "api_key",
        credential_env: "OPENROUTER_API_KEY"
      }
    },
    models: {
      "sonnet-via-openrouter": {
        endpoint: "openrouter-openai",
        model_name: "anthropic/claude-sonnet-4",
        context_window: 200000,
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
            account: "openrouter-main",
            model: "sonnet-via-openrouter"
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
  };
}

describe("selectRoute", () => {
  it("selects the first eligible route", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test");

    const config = loadConfig({
      override: buildBaseConfig()
    });

    const registry = buildProviderRegistry(config);
    const catalog = new ModelCatalog(config);
    const route = selectRoute(
      config,
      catalog,
      new PriceTable(config),
      registry.platforms,
      registry.providers,
      registry.endpoints,
      registry.accounts,
      "auto",
      false,
      false,
      10,
      "normal"
    );

    expect(route.selected.platform.id).toBe("openai");
    expect(route.selected.provider.id).toBe("openrouter");
    expect(route.selected.endpoint.id).toBe("openrouter-openai");
    expect(route.selected.account.id).toBe("openrouter-main");
    expect(route.selected.modelId).toBe("sonnet-via-openrouter");

    vi.unstubAllEnvs();
  });

  it("rejects public-only providers for normal privacy requests", () => {
    vi.stubEnv("RELAY_A_API_KEY", "test");

    const config = loadConfig({
      override: {
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
            base_url: "https://relay.example.com/v1"
          }
        },
        accounts: {
          "relay-main": {
            endpoint: "relay-openai",
            account_type: "api_key",
            credential_env: "RELAY_A_API_KEY"
          }
        },
        models: {
          "relay-model": {
            endpoint: "relay-openai",
            model_name: "deepseek-chat"
          }
        },
        routes: {
          auto: {
            policy: "balanced",
            candidates: [
              {
                account: "relay-main",
                model: "relay-model"
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
    const catalog = new ModelCatalog(config);

    expect(() =>
      selectRoute(
        config,
        catalog,
        new PriceTable(config),
        registry.platforms,
        registry.providers,
        registry.endpoints,
        registry.accounts,
        "auto",
        false,
        false,
        10,
        "normal"
      )
    ).toThrow(HttpError);

    vi.unstubAllEnvs();
  });

  it("selects different candidates for cheap and coding routes based on policy weights", () => {
    vi.stubEnv("PRIMARY_API_KEY", "primary");
    vi.stubEnv("CHEAP_API_KEY", "cheap");

    const config = loadConfig({
      override: {
        providers: {
          premium: {
            display_name: "Premium",
            trust_level: "high",
            privacy_level: "normal",
            usage_trust: "high",
            protocol: "openai",
            adapter: "openai_compatible",
            base_url: "https://premium.example.com/v1",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            },
            accounts: [{ id: "main", credential_env: "PRIMARY_API_KEY" }],
            models: [
              {
                id: "gpt-5-5",
                model_name: "gpt-5.5",
                context_window: 1000000,
                capabilities: {
                  streaming: true,
                  tools: true,
                  json_mode: true
                },
                pricing: {
                  input_per_1m: 10,
                  output_per_1m: 20,
                  source: "manual",
                  confidence: "medium"
                }
              }
            ]
          },
          budget: {
            display_name: "Budget",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium",
            protocol: "openai",
            adapter: "openai_compatible",
            base_url: "https://budget.example.com/v1",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            },
            accounts: [{ id: "main", credential_env: "CHEAP_API_KEY" }],
            models: [
              {
                id: "gpt-5-4-mini",
                model_name: "gpt-5.4-mini",
                context_window: 256000,
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
            ]
          }
        },
        routes: {
          auto: {
            policy: "balanced",
            candidates: [
              { provider: "premium", account: "main", model: "gpt-5-5" },
              { provider: "budget", account: "main", model: "gpt-5-4-mini" }
            ]
          },
          cheap: {
            policy: "cost_first",
            candidates: [
              { provider: "premium", account: "main", model: "gpt-5-5" },
              { provider: "budget", account: "main", model: "gpt-5-4-mini" }
            ]
          },
          coding: {
            policy: "coding_first",
            candidates: [
              { provider: "premium", account: "main", model: "gpt-5-5" },
              { provider: "budget", account: "main", model: "gpt-5-4-mini" }
            ]
          }
        },
        policies: {
          balanced: {
            min_trust_level: "low",
            sticky_session: true,
            weights: {
              health: 1,
              trust: 1,
              quality: 0.8,
              cost: 0.3,
              context: 0.2,
              tools: 0.2,
              sticky: 0.4,
              error_penalty: 1,
              quota_penalty: 1
            }
          },
          cost_first: {
            thresholds: {
              min_trust_level: "low"
            },
            weights: {
              health: 0.5,
              trust: 0.4,
              quality: 0.1,
              cost: 2,
              context: 0.1,
              tools: 0.1,
              sticky: 0,
              error_penalty: 0.5,
              quota_penalty: 0.5
            }
          },
          coding_first: {
            thresholds: {
              min_trust_level: "low",
              require_tools: true
            },
            weights: {
              health: 0.8,
              trust: 0.8,
              quality: 1,
              cost: 0.1,
              context: 1,
              tools: 1.5,
              sticky: 0.2,
              error_penalty: 0.6,
              quota_penalty: 0.3
            }
          }
        },
        defaults: {
          model: "auto",
          policy: "balanced",
          privacy_level: "normal"
        }
      }
    });

    const registry = buildProviderRegistry(config);
    const catalog = new ModelCatalog(config);
    const priceTable = new PriceTable(config);

    const cheapRoute = selectRoute(
      config,
      catalog,
      priceTable,
      registry.platforms,
      registry.providers,
      registry.endpoints,
      registry.accounts,
      "cheap",
      false,
      false,
      1000,
      "normal"
    );
    const codingRoute = selectRoute(
      config,
      catalog,
      priceTable,
      registry.platforms,
      registry.providers,
      registry.endpoints,
      registry.accounts,
      "coding",
      true,
      false,
      1000,
      "normal"
    );

    expect(cheapRoute.selected.provider.id).toBe("budget");
    expect(codingRoute.selected.provider.id).toBe("premium");

    vi.unstubAllEnvs();
  });
});
