import { describe, expect, it, vi } from "vitest";

import { buildProviderRegistry } from "../../src/catalog/providerRegistry.js";
import { loadConfig } from "../../src/config/loadConfig.js";

describe("buildProviderRegistry", () => {
  it("maps platforms, providers, endpoints, and accounts", () => {
    vi.stubEnv("DEMO_API_KEY", "secret");

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
            trust_level: "low",
            privacy_level: "public_only",
            usage_trust: "low"
          }
        },
        endpoints: {
          "demo-openai": {
            provider: "demo",
            platform: "openai",
            adapter: "openai_compatible",
            base_url: "https://example.com/v1"
          }
        },
        accounts: {
          "demo-account": {
            endpoint: "demo-openai",
            account_type: "api_key",
            credential_env: "DEMO_API_KEY"
          }
        },
        models: {
          "demo-model": {
            endpoint: "demo-openai",
            model_name: "gpt-test"
          }
        },
        routes: {
          auto: {
            policy: "balanced",
            candidates: [
              {
                account: "demo-account",
                model: "demo-model"
              }
            ]
          }
        }
      }
    });

    const registry = buildProviderRegistry(config);

    expect(registry.platforms).toHaveLength(1);
    expect(registry.platforms[0].protocol).toBe("openai");
    expect(registry.providers[0].trust_level).toBe("low");
    expect(registry.providers[0].privacy_level).toBe("public_only");
    expect(registry.endpoints[0].platform_id).toBe("openai");
    expect(registry.endpoints[0].provider_id).toBe("demo");
    expect(registry.accounts[0].available).toBe(true);

    vi.unstubAllEnvs();
  });
});
