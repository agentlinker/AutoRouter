import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockAgent, setGlobalDispatcher } from "undici";

import { loadConfig } from "../../src/config/loadConfig.js";
import { createDatabaseClient } from "../../src/db/client.js";
import { ProviderModelDiscoveryService } from "../../src/discovery/providerModelDiscovery.js";
import { AdapterRegistry } from "../../src/providers/registry.js";
import { ManagedProviderRepository } from "../../src/repositories/managedProviderRepository.js";
import { StickySessionStore } from "../../src/routing/stickySession.js";
import { RuntimeManager } from "../../src/runtime/runtimeManager.js";
import { SecretCipher } from "../../src/security/secretCipher.js";
import { createServer } from "../../src/server/createServer.js";
import { TraceStore } from "../../src/trace/traceStore.js";
import { createLogger } from "../../src/utils/logger.js";

describe("admin providers integration", () => {
  let mockAgent: MockAgent;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autorouter-admin-"));
    vi.stubEnv("AUTO_ROUTER_TOKEN", "gateway-token");
    vi.stubEnv("AUTO_ROUTER_ADMIN_TOKEN", "admin-token");
    vi.stubEnv(
      "AUTO_ROUTER_MASTER_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
    await mockAgent.close();
  });

  it("creates a managed provider, reloads runtime, and serves bare model requests", async () => {
    const pool = mockAgent.get("https://managed.example.com");

    pool
      .intercept({
        path: "/v1/models",
        method: "GET"
      })
      .reply(200, {
        object: "list",
        data: [
          {
            id: "managed-model",
            object: "model",
            context_window: 64000,
            supports_tools: true,
            supports_json_mode: true
          }
        ]
      });

    pool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(200, {
        id: "chatcmpl_managed",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "managed-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "managed ok"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 6,
          completion_tokens: 4,
          total_tokens: 10
        }
      });

    pool
      .intercept({
        path: "/v2/models",
        method: "GET"
      })
      .reply(200, {
        object: "list",
        data: [
          {
            id: "managed-model-v2",
            object: "model",
            context_window: 128000
          }
        ]
      });

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
    const adapters = new AdapterRegistry();
    const stickySessions = new StickySessionStore();
    const traceStore = new TraceStore(config.trace.directory);
    const secretCipher = new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY);
    const runtimeManager = new RuntimeManager({
      baseConfig: config,
      managedProviderRepository: repository,
      secretCipher,
      adapters,
      stickySessions,
      traceStore,
      logger: createLogger()
    });
    const discoveryService = new ProviderModelDiscoveryService();

    const server = await createServer(runtimeManager, {
      managedProviderRepository: repository,
      discoveryService,
      secretCipher
    });

    const adminPageResponse = await server.inject({
      method: "GET",
      url: "/admin"
    });

    expect(adminPageResponse.statusCode).toBe(200);
    expect(adminPageResponse.body).toContain("AutoRouter Admin");
    expect(adminPageResponse.body).toContain('id="root"');

    const unauthorizedAdminApiResponse = await server.inject({
      method: "GET",
      url: "/admin/api/providers"
    });

    expect(unauthorizedAdminApiResponse.statusCode).toBe(401);
    expect(unauthorizedAdminApiResponse.json().error.code).toBe("unauthorized");

    const createResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "managed",
        display_name: "Managed Provider",
        base_url: "https://managed.example.com/v1",
        website_url: "https://managed.example.com",
        api_key: "managed-secret"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().models).toHaveLength(1);
    expect(createResponse.json().models[0].model_name).toBe("managed-model");

    const modelsResponse = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer gateway-token"
      }
    });

    expect(modelsResponse.statusCode).toBe(200);
    const listedModels = modelsResponse.json().data.map((item: { id: string }) => item.id);
    expect(listedModels).toContain("managed-model");
    expect(listedModels).toContain("managed/managed-model");

    const chatResponse = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer gateway-token"
      },
      payload: {
        model: "managed-model",
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(chatResponse.statusCode).toBe(200);
    expect(chatResponse.json().choices[0].message.content).toBe("managed ok");
    expect(chatResponse.headers["x-autorouter-normalized-model"]).toBe("auto/managed-model");

    const providerResponse = await server.inject({
      method: "GET",
      url: "/admin/api/providers/managed",
      headers: {
        authorization: "Bearer admin-token"
      }
    });

    expect(providerResponse.statusCode).toBe(200);
    expect(providerResponse.json().website_url).toBe("https://managed.example.com");
    expect(providerResponse.json().key_hint).toBe("...cret");
    expect(providerResponse.json().latest_sync.status).toBe("success");

    const editResponse = await server.inject({
      method: "PATCH",
      url: "/admin/api/providers/managed",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        display_name: "Managed Provider Edited",
        base_url: "https://managed.example.com/v2",
        website_url: "https://managed.example.com/docs"
      }
    });

    expect(editResponse.statusCode).toBe(200);
    expect(editResponse.json().display_name).toBe("Managed Provider Edited");
    expect(editResponse.json().base_url).toBe("https://managed.example.com/v2");
    expect(editResponse.json().website_url).toBe("https://managed.example.com/docs");
    expect(editResponse.json().models).toHaveLength(1);
    expect(editResponse.json().models[0].model_name).toBe("managed-model-v2");

    await server.close();
  });
});
