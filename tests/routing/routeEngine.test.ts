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
});
