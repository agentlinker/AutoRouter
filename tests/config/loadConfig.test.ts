import { describe, expect, it } from "vitest";

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
  });
});
