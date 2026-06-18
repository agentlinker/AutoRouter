import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/loadConfig.js";

describe("loadConfig", () => {
  it("merges override config and applies defaults", () => {
    const config = loadConfig({
      override: {
        platforms: {
          demo: {
            display_name: "Demo",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium"
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

    expect(config.server.host).toBe("127.0.0.1");
    expect(config.endpoints["demo-openai"].protocol).toBe("openai_compatible");
    expect(config.platforms.demo.display_name).toBe("Demo");
  });
});
