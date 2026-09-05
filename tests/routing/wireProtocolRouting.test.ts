import { describe, expect, it } from "vitest";

import { ModelCatalog } from "../../src/catalog/modelCatalog.js";
import { PriceTable } from "../../src/catalog/priceTable.js";
import { buildProviderRegistry } from "../../src/catalog/providerRegistry.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { selectRoute } from "../../src/routing/routeEngine.js";

const protocols = ["openai-responses", "openai-chat-completions", "anthropic-messages"] as const;

function select(requiredProtocol: typeof protocols[number], available: readonly string[] = protocols) {
  const config = loadConfig({ override: {
    providers: Object.fromEntries(available.map((protocol) => [protocol, {
      protocol, base_url: "https://example.com/v1", privacy_level: "normal",
      accounts: [{ id: "main", account_type: "local_model" }],
      models: [{ id: "model", model_name: "model" }]
    }])),
    routes: { auto: { policy: "balanced", candidates: available.map((protocol) => ({
      provider: protocol, account: "main", model: "model"
    })) } }
  } });
  const registry = buildProviderRegistry(config);
  registry.providers.forEach((provider) => { provider.priority = provider.id === requiredProtocol ? 0 : 100; });
  return selectRoute(config, new ModelCatalog(config), new PriceTable(config),
    registry.platforms, registry.providers, registry.endpoints, registry.accounts,
    "auto", false, false, 1, "normal", {
      routeId: "auto", platformId: "openai-chat-completions", providerId: "openai-chat-completions",
      endpointId: "openai-chat-completions/default", accountId: "openai-chat-completions/main",
      modelId: "openai-chat-completions/model"
    }, {}, requiredProtocol);
}

describe("required wire protocol routing", () => {
  it.each(protocols)("excludes other protocols before scoring or sticky selection for %s", (protocol) => {
    const decision = select(protocol);
    expect(decision.ordered.map((candidate) => candidate.platform.protocol)).toEqual([protocol]);
    expect(decision.filtered).toHaveLength(2);
    expect(decision.filtered.map((candidate) => candidate.filteredReason))
      .toEqual(["required_protocol", "required_protocol"]);
  });

  it.each(protocols)("reports required_protocol_unavailable when %s is absent", (protocol) => {
    expect(() => select(protocol, protocols.filter((candidate) => candidate !== protocol)))
      .toThrow(expect.objectContaining({ code: "required_protocol_unavailable" }));
  });
});
