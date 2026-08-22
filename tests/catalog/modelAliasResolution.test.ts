import { describe, expect, it, vi } from "vitest";

import { ModelCatalog } from "../../src/catalog/modelCatalog.js";
import { loadConfig } from "../../src/config/loadConfig.js";

/**
 * 中转站常以带命名空间的写法暴露模型（deepseek-ai/deepseek-v4-pro），
 * 客户端照抄 /v1/models 的返回来请求，必须能解析到对应候选。
 * 这些写法存在 logical_models.aliases_json 里，经 config.models[].aliases 投影进来。
 */
function buildCatalog(aliases: string[]): ModelCatalog {
  vi.stubEnv("ALIAS_DEMO_KEY", "secret");

  const config = loadConfig({
    override: {
      platforms: { openai: { protocol: "openai" } },
      providers: {
        relay: {
          display_name: "Relay",
          trust_level: "low",
          privacy_level: "public_only",
          usage_trust: "low"
        }
      },
      endpoints: {
        "relay/default": {
          provider: "relay",
          platform: "openai",
          adapter: "openai_compatible",
          base_url: "https://relay.example/v1"
        }
      },
      accounts: {
        "relay/default/default": {
          endpoint: "relay/default",
          account_type: "api_key",
          credential_env: "ALIAS_DEMO_KEY"
        }
      },
      models: {
        "relay/deepseek-v4-pro": {
          endpoint: "relay/default",
          model_name: "deepseek-v4-pro",
          aliases
        }
      }
    }
  });

  return new ModelCatalog(config);
}

describe("model alias resolution", () => {
  it("resolves an upstream namespaced id through aliases", () => {
    const catalog = buildCatalog(["deepseek-ai/deepseek-v4-pro"]);

    const target = catalog.resolveRequestTarget("deepseek-ai/deepseek-v4-pro");

    expect(target).not.toBeNull();
    expect(target?.candidates).toHaveLength(1);
    expect(target?.candidates[0]?.modelId).toBe("relay/deepseek-v4-pro");
    expect(target?.candidates[0]?.model).toBe("deepseek-v4-pro");
  });

  it("still resolves the logical name itself", () => {
    const catalog = buildCatalog(["deepseek-ai/deepseek-v4-pro"]);

    const target = catalog.resolveRequestTarget("deepseek-v4-pro");

    expect(target?.mode).toBe("bare_model");
    expect(target?.candidates).toHaveLength(1);
    expect(target?.candidates[0]?.modelId).toBe("relay/deepseek-v4-pro");
  });

  it("matches aliases case-insensitively", () => {
    const catalog = buildCatalog(["DeepSeek-AI/DeepSeek-V4-Pro"]);

    const target = catalog.resolveRequestTarget("deepseek-ai/deepseek-v4-pro");

    expect(target?.candidates).toHaveLength(1);
    expect(target?.candidates[0]?.modelId).toBe("relay/deepseek-v4-pro");
  });

  it("resolves the legacy normalized name kept as an alias", () => {
    // 迁移把旧名字保留成 alias，老客户端不至于直接失效。
    const catalog = buildCatalog(["deepseek-v-4-pro"]);

    const target = catalog.resolveRequestTarget("deepseek-v-4-pro");

    expect(target?.candidates).toHaveLength(1);
    expect(target?.candidates[0]?.model).toBe("deepseek-v4-pro");
  });

  it("resolves aliases under the auto/ prefix", () => {
    const catalog = buildCatalog(["deepseek-ai/deepseek-v4-pro"]);

    const target = catalog.resolveRequestTarget("auto/deepseek-ai/deepseek-v4-pro");

    expect(target?.mode).toBe("auto_model");
    expect(target?.candidates).toHaveLength(1);
    expect(target?.candidates[0]?.modelId).toBe("relay/deepseek-v4-pro");
  });

  it("resolves aliases under a provider prefix", () => {
    const catalog = buildCatalog(["deepseek-v4-pro-latest"]);

    const target = catalog.resolveRequestTarget("relay/deepseek-v4-pro-latest");

    expect(target?.mode).toBe("provider_model");
    expect(target?.candidates).toHaveLength(1);
    expect(target?.candidates[0]?.modelId).toBe("relay/deepseek-v4-pro");
  });

  it("returns no candidates for an unknown name", () => {
    const catalog = buildCatalog(["deepseek-ai/deepseek-v4-pro"]);

    expect(catalog.getCandidates("totally-unknown-model")).toEqual([]);
  });

  it("keeps working when a model has no aliases", () => {
    const catalog = buildCatalog([]);

    expect(catalog.resolveRequestTarget("deepseek-v4-pro")?.candidates).toHaveLength(1);
    expect(catalog.getCandidates("deepseek-ai/deepseek-v4-pro")).toEqual([]);
  });
});
