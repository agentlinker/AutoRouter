import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config/loadConfig.js";
import { createDatabaseClient } from "../../src/db/client.js";
import { ProviderModelDiscoveryService } from "../../src/discovery/providerModelDiscovery.js";
import { AdapterRegistry } from "../../src/providers/registry.js";
import { ManagedProviderRepository } from "../../src/repositories/managedProviderRepository.js";
import { RouteTraceRepository } from "../../src/repositories/routeTraceRepository.js";
import { StickySessionStore } from "../../src/routing/stickySession.js";
import { RuntimeManager } from "../../src/runtime/runtimeManager.js";
import { SecretCipher } from "../../src/security/secretCipher.js";
import { createServer } from "../../src/server/createServer.js";
import { TraceStore } from "../../src/trace/traceStore.js";
import { createLogger } from "../../src/utils/logger.js";

describe("Admin wire protocol contracts", () => {
  let database: ReturnType<typeof createDatabaseClient>;
  let server: Awaited<ReturnType<typeof createServer>>;
  let repository: ManagedProviderRepository;
  const headers = { authorization: "Bearer admin-token" };
  const payload = (protocol: string) => ({ provider_key: "relay", display_name: "Relay",
    api_key: "test-key", protocol, base_url: "https://relay.example/v1",
    model_catalog_url: "https://relay.example/v1/models" });

  beforeEach(async () => {
    vi.stubEnv("AUTO_ROUTER_ADMIN_TOKEN", "admin-token");
    database = createDatabaseClient(":memory:");
    repository = new ManagedProviderRepository(database.db);
    const secretCipher = new SecretCipher("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const runtimeManager = new RuntimeManager({ baseConfig: loadConfig({ override: {} }),
      managedProviderRepository: repository, secretCipher, adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: new TraceStore(new RouteTraceRepository(database.db)), logger: createLogger() });
    const discoveryService = new ProviderModelDiscoveryService(async () => ({
      statusCode: 200, body: { json: async () => ({ data: [{ id: "model" }] }) }
    }));
    server = await createServer(runtimeManager, { managedProviderRepository: repository, secretCipher, discoveryService });
  });
  afterEach(async () => {
    await server.close();
    database.sqlite.close();
    vi.unstubAllEnvs();
  });

  it.each(["openai-responses", "openai-chat-completions", "anthropic-messages"])(
    "creates an explicit %s Endpoint with its protocol-derived key", async (protocol) => {
      const response = await server.inject({ method: "POST", url: "/admin/api/providers", headers, payload: payload(protocol) });
      expect(response.statusCode).toBe(201);
      expect(repository.getProviderDetails("relay")?.endpoints.map((endpoint) => ({
        key: endpoint.endpointKey, protocol: endpoint.protocol
      }))).toEqual([{ key: protocol, protocol }]);
    }
  );

  it.each(["openai", "anthropic", "all"])("rejects %s before persisting a Provider", async (protocol) => {
    const response = await server.inject({ method: "POST", url: "/admin/api/providers", headers, payload: payload(protocol) });
    expect(response.statusCode).toBe(400);
    expect(repository.getProviderDetails("relay")).toBeNull();
  });

  it("administers Account-Endpoint state without changing the Account", async () => {
    expect((await server.inject({ method: "POST", url: "/admin/api/providers", headers,
      payload: payload("anthropic-messages") })).statusCode).toBe(201);
    repository.applyAccountEndpointFailure("relay", "default", "anthropic-messages", {
      runtimeStatus: "disabled", reason: "access_denied", cooldownUntil: null,
      code: "group_access_denied", message: "group cannot dispatch messages"
    });

    const detail = await server.inject({ method: "GET", url: "/admin/api/providers/relay", headers });
    expect(detail.json().account_endpoints).toEqual([
      expect.objectContaining({ account_key: "default", endpoint_key: "anthropic-messages",
        enabled: true, runtime_status: "disabled", last_error_code: "group_access_denied" })
    ]);
    expect(detail.json().accounts[0].runtime_status).toBe("normal");

    const disable = await server.inject({ method: "PATCH",
      url: "/admin/api/providers/relay/accounts/default/endpoints/anthropic-messages", headers,
      payload: { enabled: false } });
    expect(disable.statusCode).toBe(200);
    expect(disable.json().account_endpoints[0].enabled).toBe(false);

    const clear = await server.inject({ method: "POST",
      url: "/admin/api/providers/relay/accounts/default/endpoints/anthropic-messages/clear-status", headers });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().account_endpoints[0]).toMatchObject({ enabled: false,
      runtime_status: "unknown", last_success_at: null, last_error_message: null });

    const enable = await server.inject({ method: "PATCH",
      url: "/admin/api/providers/relay/accounts/default/endpoints/anthropic-messages", headers,
      payload: { enabled: true } });
    expect(enable.json().account_endpoints[0]).toMatchObject({ enabled: true, runtime_status: "unknown" });
  });
});
