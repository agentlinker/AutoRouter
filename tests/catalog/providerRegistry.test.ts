import { describe, expect, it, vi } from "vitest";

import { buildProviderRegistry } from "../../src/catalog/providerRegistry.js";
import { loadConfig } from "../../src/config/loadConfig.js";

describe("buildProviderRegistry", () => {
  it("maps providers and accounts with default trust and privacy", () => {
    vi.stubEnv("DEMO_API_KEY", "secret");

    const config = loadConfig({
      override: {
        platforms: {
          demo: {
            display_name: "Demo",
            trust_level: "low",
            privacy_level: "public_only",
            usage_trust: "low"
          }
        },
        endpoints: {
          "demo-openai": {
            platform: "demo",
            protocol: "openai_compatible",
            base_url: "https://example.com/v1",
            accounts: [
              {
                id: "demo-account",
                account_type: "api_key",
                api_key_env: "DEMO_API_KEY"
              }
            ]
          }
        }
      }
    });

    const registry = buildProviderRegistry(config);

    expect(registry.platforms).toHaveLength(1);
    expect(registry.platforms[0].trust_level).toBe("low");
    expect(registry.platforms[0].privacy_level).toBe("public_only");
    expect(registry.endpoints[0].platform_id).toBe("demo");
    expect(registry.accounts[0].available).toBe(true);

    vi.unstubAllEnvs();
  });
});
