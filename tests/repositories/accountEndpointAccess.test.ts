import { afterEach, describe, expect, it } from "vitest";

import { createDatabaseClient } from "../../src/db/client.js";
import { ManagedProviderRepository } from "../../src/repositories/managedProviderRepository.js";

const clients: ReturnType<typeof createDatabaseClient>[] = [];
afterEach(() => clients.splice(0).forEach((client) => client.sqlite.close()));

function createRepository() {
  const client = createDatabaseClient(":memory:");
  clients.push(client);
  const repository = new ManagedProviderRepository(client.db);
  repository.createProviderWithEndpointBundles({
    provider: { providerKey: "relay", displayName: "Relay", baseUrl: "https://example.com/v1" },
    encryptedApiKey: "encrypted",
    endpointBundles: ["openai", "anthropic"].map((protocol) => ({
      endpoint: { endpointKey: protocol, protocol: protocol as "openai" | "anthropic",
        baseUrl: "https://example.com/v1" },
      models: [{ modelKey: "relay/model", providerModelId: "model", modelName: "model",
        supportsStreaming: true, supportsTools: false, supportsJsonMode: false }]
    }))
  });
  return repository;
}

describe("Account-Endpoint access", () => {
  it("keeps absent relations unknown and eligible without materializing the product", () => {
    const repository = createRepository();
    expect(repository.getAccountEndpoint("relay", "default", "openai")).toBeNull();
    expect(repository.listEnabledProviderBundles().map((bundle) => bundle.accountEndpoint))
      .toEqual([null, null]);
  });

  it("disables only one relation and preserves administrative state when observations are cleared", () => {
    const repository = createRepository();
    repository.setAccountEndpointEnabled("relay", "default", "anthropic", false);
    expect(repository.listEnabledProviderBundles().map((bundle) => bundle.endpoint.endpointKey))
      .toEqual(["openai"]);
    repository.clearAccountEndpointStatus("relay", "default", "anthropic");
    expect(repository.getAccountEndpoint("relay", "default", "anthropic"))
      .toMatchObject({ enabled: false, runtimeStatus: "unknown", lastSuccessAt: null });
    repository.setAccountEndpointEnabled("relay", "default", "anthropic", true);
    expect(repository.listEnabledProviderBundles()).toHaveLength(2);
    expect(repository.getAccount("relay", "default")?.enabled).toBe(true);
  });

  it("isolates protocol access denial and clears it to unknown without claiming success", () => {
    const repository = createRepository();
    repository.applyAccountEndpointFailure("relay", "default", "anthropic", {
      runtimeStatus: "disabled", reason: "access_denied", cooldownUntil: null,
      message: "group cannot dispatch messages", code: "group_access_denied"
    });
    expect(repository.listEnabledProviderBundles().map((bundle) => bundle.endpoint.endpointKey))
      .toEqual(["openai"]);
    expect(repository.getAccountEndpoint("relay", "default", "openai")).toBeNull();
    expect(repository.getAccount("relay", "default")?.runtimeStatus).toBe("normal");
    repository.clearAccountEndpointStatus("relay", "default", "anthropic");
    expect(repository.getAccountEndpoint("relay", "default", "anthropic"))
      .toMatchObject({ runtimeStatus: "unknown", recentErrorCount: 0,
        lastSuccessAt: null, lastErrorMessage: null });
    expect(repository.listEnabledProviderBundles()).toHaveLength(2);
  });

  it("records a real success without overriding administrative disablement", () => {
    const repository = createRepository();
    repository.setAccountEndpointEnabled("relay", "default", "anthropic", false);
    repository.markAccountEndpointSuccess("relay", "default", "anthropic", true);
    expect(repository.getAccountEndpoint("relay", "default", "anthropic"))
      .toMatchObject({ enabled: false, runtimeStatus: "normal", lastSuccessAt: expect.any(String) });
    expect(repository.listEnabledProviderBundles()).toHaveLength(1);
    expect(repository.setAccountEndpointEnabled("other", "default", "anthropic", true)).toBeNull();
  });
});
