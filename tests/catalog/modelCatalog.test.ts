import { describe, expect, it } from "vitest";

import { ModelCatalog } from "../../src/catalog/modelCatalog.js";
import { loadConfig } from "../../src/config/loadConfig.js";

describe("ModelCatalog", () => {
  it("resolves aliases and lists direct entries", () => {
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
        },
        models: {
          auto: {
            policy: "balanced",
            candidates: [
              {
                endpoint: "demo-openai",
                account: "demo-account",
                model: "gpt-test"
              }
            ]
          }
        }
      }
    });

    const catalog = new ModelCatalog(config);

    expect(catalog.resolve("auto")?.policy).toBe("balanced");
    expect(catalog.getCandidates("auto")).toHaveLength(1);
    expect(catalog.listEntries().map((entry) => entry.id)).toContain("auto");
    expect(catalog.listEntries().map((entry) => entry.id)).toContain("demo-openai/gpt-test");
  });
});
