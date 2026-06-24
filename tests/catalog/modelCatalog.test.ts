import { describe, expect, it } from "vitest";

import { ModelCatalog } from "../../src/catalog/modelCatalog.js";
import { loadConfig } from "../../src/config/loadConfig.js";

describe("ModelCatalog", () => {
  it("resolves routes and models and expands route candidates", () => {
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
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium"
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

    const catalog = new ModelCatalog(config);

    expect(catalog.resolveRoute("auto")?.policy).toBe("balanced");
    expect(catalog.resolveModel("demo-model")?.model_name).toBe("gpt-test");
    expect(catalog.getCandidates("auto")).toHaveLength(1);
    expect(catalog.listEntries().map((entry) => entry.id)).toContain("auto");
    expect(catalog.listEntries().map((entry) => entry.id)).toContain("gpt-test");
    expect(catalog.listEntries().map((entry) => entry.id)).toContain("demo-model");
  });

  it("resolves auto/model and provider/model before route alias, and keeps bare model as sugar", () => {
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
            accounts: [{ id: "main", credential_env: "DEMO_API_KEY" }],
            models: [
              { id: "gpt-5-5", model_name: "gpt-5.5" },
              { id: "qwen-plus", model_name: "qwen/qwen3.6-plus" },
              { id: "auto", model_name: "auto" }
            ]
          }
        },
        routes: {
          auto: {
            policy: "balanced",
            candidates: [{ provider: "demo", account: "main", model: "auto" }]
          }
        }
      }
    });

    const catalog = new ModelCatalog(config);

    const autoModel = catalog.resolveRequestTarget("auto/gpt-5.5");
    expect(autoModel).toMatchObject({
      mode: "auto_model",
      normalized: "auto/gpt-5.5",
      candidates: expect.arrayContaining([
        expect.objectContaining({ modelId: "demo/gpt-5-5", account: "demo/main" })
      ])
    });
    expect(catalog.resolveRequestTarget("demo/gpt-5.5")).toMatchObject({
      mode: "provider_model",
      normalized: "demo/gpt-5.5",
      candidates: expect.arrayContaining([
        expect.objectContaining({ modelId: "demo/gpt-5-5", account: "demo/main" })
      ])
    });
    expect(catalog.resolveRequestTarget("demo/qwen/qwen3.6-plus")).toMatchObject({
      mode: "provider_model",
      normalized: "demo/qwen/qwen3.6-plus",
      candidates: expect.arrayContaining([
        expect.objectContaining({ modelId: "demo/qwen-plus", account: "demo/main" })
      ])
    });
    expect(catalog.resolveRequestTarget("auto")).toMatchObject({
      mode: "route_alias",
      normalized: "auto",
      candidates: expect.arrayContaining([
        expect.objectContaining({ modelId: "demo/auto", account: "demo/main" })
      ])
    });
    expect(catalog.resolveRequestTarget("gpt-5.5")).toMatchObject({
      mode: "bare_model",
      normalized: "auto/gpt-5.5",
      candidates: expect.arrayContaining([
        expect.objectContaining({ modelId: "demo/gpt-5-5", account: "demo/main" })
      ])
    });
  });
});
