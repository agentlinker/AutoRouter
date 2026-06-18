import { describe, expect, it, vi } from "vitest";

import { ModelCatalog } from "../../src/catalog/modelCatalog.js";
import { PriceTable } from "../../src/catalog/priceTable.js";
import { buildProviderRegistry } from "../../src/catalog/providerRegistry.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { selectRoute } from "../../src/routing/routeEngine.js";
import { HttpError } from "../../src/utils/httpErrors.js";

describe("selectRoute", () => {
  it("selects the first eligible route", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test");

    const config = loadConfig({
      override: {
        platforms: {
          openrouter: {
            display_name: "OpenRouter",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium"
          }
        },
        endpoints: {
          "openrouter-openai": {
            platform: "openrouter",
            protocol: "openrouter",
            base_url: "https://openrouter.ai/api/v1",
            accounts: [
              {
                id: "openrouter-main",
                account_type: "api_key",
                api_key_env: "OPENROUTER_API_KEY"
              }
            ]
          }
        },
        models: {
          auto: {
            policy: "balanced",
            candidates: [
              {
                endpoint: "openrouter-openai",
                account: "openrouter-main",
                model: "anthropic/claude-sonnet-4"
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
    const catalog = new ModelCatalog(config);
    const route = selectRoute(
      config,
      catalog,
      new PriceTable(config),
      registry.platforms,
      registry.endpoints,
      registry.accounts,
      "auto",
      false,
      false,
      "normal"
    );

    expect(route.selected.platform.id).toBe("openrouter");
    expect(route.selected.endpoint.id).toBe("openrouter-openai");
    expect(route.selected.account.id).toBe("openrouter-main");

    vi.unstubAllEnvs();
  });

  it("rejects public-only providers for normal privacy requests", () => {
    vi.stubEnv("RELAY_A_API_KEY", "test");

    const config = loadConfig({
      override: {
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
                id: "relay-main",
                account_type: "api_key",
                api_key_env: "RELAY_A_API_KEY"
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
                account: "relay-main",
                model: "deepseek-chat"
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
        registry.endpoints,
        registry.accounts,
        "auto",
        false,
        false,
        "normal"
      )
    ).toThrow(HttpError);

    vi.unstubAllEnvs();
  });

  it("prefers sticky session route when candidates are otherwise equivalent", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test");
    vi.stubEnv("SECONDARY_API_KEY", "test");

    const config = loadConfig({
      override: {
        platforms: {
          primary: {
            display_name: "Primary",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium"
          },
          secondary: {
            display_name: "Secondary",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium"
          }
        },
        endpoints: {
          "primary-openai": {
            platform: "primary",
            protocol: "openrouter",
            base_url: "https://primary.example.com/v1",
            accounts: [
              {
                id: "primary-account",
                account_type: "api_key",
                api_key_env: "OPENROUTER_API_KEY"
              }
            ]
          },
          "secondary-openai": {
            platform: "secondary",
            protocol: "openrouter",
            base_url: "https://secondary.example.com/v1",
            accounts: [
              {
                id: "secondary-account",
                account_type: "api_key",
                api_key_env: "SECONDARY_API_KEY"
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
                model: "model-a"
              },
              {
                endpoint: "secondary-openai",
                account: "secondary-account",
                model: "model-b"
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
    const catalog = new ModelCatalog(config);
    const route = selectRoute(
      config,
      catalog,
      new PriceTable(config),
      registry.platforms,
      registry.endpoints,
      registry.accounts,
      "auto",
      false,
      false,
      "normal",
      {
        endpointId: "secondary-openai",
        accountId: "secondary-account",
        model: "model-b"
      }
    );

    expect(route.selected.platform.id).toBe("secondary");
    expect(route.selected.endpoint.id).toBe("secondary-openai");
    expect(route.selected.account.id).toBe("secondary-account");

    vi.unstubAllEnvs();
  });

  it("filters candidates with exhausted quota", () => {
    vi.stubEnv("PRIMARY_API_KEY", "test");

    const config = loadConfig({
      override: {
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
            base_url: "https://primary.example.com/v1",
            accounts: [
              {
                id: "primary-account",
                account_type: "api_key",
                api_key_env: "PRIMARY_API_KEY",
                quota: {
                  remaining_usd: 0
                }
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
                model: "model-a"
              }
            ]
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
        registry.endpoints,
        registry.accounts,
        "auto",
        false,
        false,
        "normal"
      )
    ).toThrow(HttpError);

    vi.unstubAllEnvs();
  });
});
