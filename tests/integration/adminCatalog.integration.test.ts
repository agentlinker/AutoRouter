import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

describe("admin catalog integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autorouter-catalog-"));
    vi.stubEnv("AUTO_ROUTER_TOKEN", "gateway-token");
    vi.stubEnv("AUTO_ROUTER_ADMIN_TOKEN", "admin-token");
    vi.stubEnv(
      "AUTO_ROUTER_MASTER_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists logical catalog records and reloads runtime after disabling an instance", async () => {
    const config = loadConfig({
      override: {
        server: {
          host: "127.0.0.1",
          port: 8811,
          request_timeout_ms: 120000,
          gateway_token_env: "AUTO_ROUTER_TOKEN",
          admin_token_env: "AUTO_ROUTER_ADMIN_TOKEN"
        },
        database: {
          path: join(tempDir, "autorouter.db")
        },
        trace: {
          directory: join(tempDir, "traces"),
          log_prompts: false
        },
        routes: {},
        providers: {},
        endpoints: {},
        accounts: {},
        models: {},
        policies: {}
      }
    });

    const databaseClient = createDatabaseClient(config.database.path);
    const repository = new ManagedProviderRepository(databaseClient.db);
    const secretCipher = new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY);
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const runtimeManager = new RuntimeManager({
      baseConfig: config,
      managedProviderRepository: repository,
      secretCipher,
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: new TraceStore(routeTraceRepository),
      logger: createLogger()
    });

    repository.createProviderWithEndpointBundles({
      provider: {
        providerKey: "catalog-provider",
        displayName: "Catalog Provider",
        adapterType: "openai_compatible",
        baseUrl: "https://catalog.example.com/v1",
        enabled: true
      },
      encryptedApiKey: secretCipher.encrypt("catalog-secret"),
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "default",
            protocol: "openai",
            adapterType: "openai_compatible",
            baseUrl: "https://catalog.example.com/v1",
            enabled: true
          },
          models: [
            {
              modelKey: "catalog-provider/catalog-model",
              providerModelId: "catalog-model",
              modelName: "catalog-model",
              contextWindow: 64_000,
              supportsStreaming: true,
              supportsTools: false,
              supportsJsonMode: false
            }
          ]
        }
      ]
    });
    await runtimeManager.reload();

    const server = await createServer(runtimeManager, {
      managedProviderRepository: repository,
      discoveryService: new ProviderModelDiscoveryService(),
      secretCipher
    });

    const listResponse = await server.inject({
      method: "GET",
      url: "/admin/api/catalog/models",
      headers: {
        authorization: "Bearer admin-token"
      }
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().data[0]).toMatchObject({
      logical_name: "catalog-model",
      context_window: 64_000
    });
    expect(listResponse.json().data[0].instances).toHaveLength(1);

    const patchResponse = await server.inject({
      method: "PATCH",
      url: "/admin/api/catalog/models/catalog-model/instances",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "catalog-provider",
        model_key: "catalog-provider/catalog-model",
        enabled: false
      }
    });

    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json().instances[0].enabled).toBe(false);

    const modelsResponse = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer gateway-token"
      }
    });

    expect(modelsResponse.statusCode).toBe(200);
    const listedModels = modelsResponse.json().data.map((item: { id: string }) => item.id);
    expect(listedModels).not.toContain("catalog-model");
    expect(listedModels).not.toContain("catalog-provider/catalog-model");
  });
});
