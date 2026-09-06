import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockAgent, setGlobalDispatcher } from "undici";

import { loadConfig } from "../../src/config/loadConfig.js";
import { createDatabaseClient } from "../../src/db/client.js";
import { ProviderModelDiscoveryService } from "../../src/discovery/providerModelDiscovery.js";
import { AdapterRegistry } from "../../src/providers/registry.js";
import { AppSettingsRepository } from "../../src/repositories/appSettingsRepository.js";
import { ManagedProviderRepository } from "../../src/repositories/managedProviderRepository.js";
import { RouteTraceRepository } from "../../src/repositories/routeTraceRepository.js";
import { StickySessionStore } from "../../src/routing/stickySession.js";
import { RuntimeManager } from "../../src/runtime/runtimeManager.js";
import { RuntimeStatusService } from "../../src/runtime/runtimeStatusService.js";
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

  it("lists providers with database-backed sorting and pagination metadata", async () => {
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
          path: join(tempDir, "autorouter-list-sort.db")
        },
        trace: {
          directory: join(tempDir, "traces-list-sort"),
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
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const adapters = new AdapterRegistry();
    const stickySessions = new StickySessionStore();
    const traceStore = new TraceStore(routeTraceRepository);
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

    for (const provider of [
      { providerKey: "alpha", displayName: "Alpha", priority: 0 },
      { providerKey: "beta", displayName: "Beta", priority: 5 }
    ]) {
      repository.createProviderWithEndpointBundles({
        provider: {
          ...provider,
          baseUrl: `https://${provider.providerKey}.example.com/v1`
        },
        encryptedApiKey: secretCipher.encrypt(`${provider.providerKey}-secret`),
        endpointBundles: [
          {
            endpoint: {
              endpointKey: "default",
              protocol: "openai-responses",
              baseUrl: `https://${provider.providerKey}.example.com/v1`
            },
            models: [
              {
                modelKey: `${provider.providerKey}-model`,
                providerModelId: `${provider.providerKey}-model`,
                modelName: `${provider.providerKey}-model`,
                supportsStreaming: true,
                supportsTools: false,
                supportsJsonMode: false
              }
            ]
          }
        ]
      });
    }
    repository.updateProviderEnabled("alpha", false);

    const response = await server.inject({
      method: "GET",
      url: "/admin/api/providers?sort_by=priority&sort_dir=desc&page=1&page_size=1",
      headers: {
        authorization: "Bearer admin-token"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      meta: {
        total: 2,
        available_total: 1,
        page: 1,
        page_size: 1,
        sort_by: "priority",
        sort_dir: "desc"
      },
      data: [
        expect.objectContaining({
          provider_key: "beta",
          priority: 5
        })
      ]
    });

    const secondPageResponse = await server.inject({
      method: "GET",
      url: "/admin/api/providers?sort_by=priority&sort_dir=desc&page=2&page_size=1",
      headers: {
        authorization: "Bearer admin-token"
      }
    });

    expect(secondPageResponse.statusCode).toBe(200);
    expect(secondPageResponse.json()).toMatchObject({
      meta: {
        total: 2,
        available_total: 1,
        page: 2,
        page_size: 1
      },
      data: [
        expect.objectContaining({
          provider_key: "alpha",
          enabled: false
        })
      ]
    });

    await server.close();
  });

  it("generates provider keys from display names and rejects conflicts", async () => {
    const pool = mockAgent.get("https://api.example.com");

    pool
      .intercept({
        path: "/v1/models",
        method: "GET"
      })
      .reply(200, {
        object: "list",
        data: [
          {
            id: "first-model",
            object: "model",
            context_window: 64000
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
          path: join(tempDir, "autorouter-generated-key.db")
        },
        trace: {
          directory: join(tempDir, "traces-generated-key"),
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
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const adapters = new AdapterRegistry();
    const stickySessions = new StickySessionStore();
    const traceStore = new TraceStore(routeTraceRepository);
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

    const firstResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        display_name: "小米模型服务",
        base_url: "https://api.example.com/v1",
        api_key: "first-secret"
      }
    });

    const secondResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        display_name: "小米模型服务",
        base_url: "https://api.example.com/v1",
        api_key: "second-secret"
      }
    });
    const existingSubsetCheck = await server.inject({
      method: "POST",
      url: "/admin/api/providers/merge-check",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "xiao-mi-mo-xing-fu-wu",
        endpoints: [
          {
            protocol: "openai-responses",
            base_url: "https://api.example.com"
          },
          {
            protocol: "anthropic-messages",
            base_url: "https://api.example.com/anthropic"
          }
        ]
      }
    });
    const addAnthropicEndpointResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers/xiao-mi-mo-xing-fu-wu/endpoints",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        protocol: "anthropic-messages",
        base_url: "https://api.example.com/anthropic"
      }
    });
    const exactEndpointCheck = await server.inject({
      method: "POST",
      url: "/admin/api/providers/merge-check",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "xiao-mi-mo-xing-fu-wu",
        endpoints: [
          {
            protocol: "openai-responses",
            base_url: "https://api.example.com"
          },
          {
            protocol: "anthropic-messages",
            base_url: "https://api.example.com/anthropic"
          }
        ]
      }
    });
    const sameEndpointCheck = await server.inject({
      method: "POST",
      url: "/admin/api/providers/merge-check",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "xiao-mi-mo-xing-fu-wu",
        endpoints: [
          {
            protocol: "openai-responses",
            base_url: "https://api.example.com"
          }
        ]
      }
    });
    const conflictingEndpointCheck = await server.inject({
      method: "POST",
      url: "/admin/api/providers/merge-check",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "xiao-mi-mo-xing-fu-wu",
        endpoints: [
          {
            protocol: "openai-responses",
            base_url: "https://api.example.com/v1"
          },
          {
            protocol: "anthropic-messages",
            base_url: "https://other.example.com/anthropic"
          }
        ]
      }
    });
    const differentEndpointCheck = await server.inject({
      method: "POST",
      url: "/admin/api/providers/merge-check",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "xiao-mi-mo-xing-fu-wu",
        endpoints: [
          {
            protocol: "openai-responses",
            base_url: "https://other.example.com/v1"
          }
        ]
      }
    });

    expect(firstResponse.statusCode).toBe(201);
    expect(firstResponse.json().provider_key).toBe("xiao-mi-mo-xing-fu-wu");
    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json().error.code).toBe("provider_key_conflict");
    expect(existingSubsetCheck.statusCode).toBe(200);
    expect(existingSubsetCheck.json().candidates).toEqual([
      expect.objectContaining({
        provider_key: "xiao-mi-mo-xing-fu-wu",
        relation: "existing_subset",
        candidate_only_endpoints: [
          {
            protocol: "anthropic-messages",
            base_url: "https://api.example.com/anthropic"
          }
        ]
      })
    ]);
    expect(addAnthropicEndpointResponse.statusCode).toBe(201);
    expect(exactEndpointCheck.statusCode).toBe(200);
    expect(exactEndpointCheck.json().candidates).toEqual([
      expect.objectContaining({
        provider_key: "xiao-mi-mo-xing-fu-wu",
        relation: "exact",
        matching_endpoints: expect.arrayContaining([
          expect.objectContaining({ protocol: "openai-responses" }),
          expect.objectContaining({ protocol: "anthropic-messages" })
        ])
      })
    ]);
    expect(sameEndpointCheck.statusCode).toBe(200);
    expect(sameEndpointCheck.json().candidates).toEqual([
      expect.objectContaining({
        provider_key: "xiao-mi-mo-xing-fu-wu",
        relation: "candidate_subset",
        matching_endpoints: [
          expect.objectContaining({ protocol: "openai-responses" })
        ],
        existing_only_endpoints: [
          expect.objectContaining({ protocol: "anthropic-messages" })
        ]
      })
    ]);
    expect(sameEndpointCheck.json().key_conflict).toEqual({
      provider_key: "xiao-mi-mo-xing-fu-wu",
      display_name: "小米模型服务"
    });
    expect(conflictingEndpointCheck.statusCode).toBe(200);
    expect(conflictingEndpointCheck.json().candidates).toEqual([
      expect.objectContaining({
        provider_key: "xiao-mi-mo-xing-fu-wu",
        relation: "conflict",
        conflicting_endpoints: [
          {
            protocol: "anthropic-messages",
            candidate_base_url: "https://other.example.com/anthropic",
            existing_base_url: "https://api.example.com/anthropic"
          }
        ]
      })
    ]);
    expect(differentEndpointCheck.statusCode).toBe(200);
    expect(differentEndpointCheck.json().candidates).toEqual([]);
    expect(differentEndpointCheck.json().key_conflict).toEqual({
      provider_key: "xiao-mi-mo-xing-fu-wu",
      display_name: "小米模型服务"
    });
    expect(repository.getProviderDetails("xiao-mi-mo-xing-fu-wu")).not.toBeNull();

    await server.close();
  });

  it("creates a provider with manual models when discovery is unsupported", async () => {
    const pool = mockAgent.get("https://manual-models.example.com");
    pool
      .intercept({
        path: "/v1/models",
        method: "GET"
      })
      .reply(400, {
        error: {
          message: "missing required parameter: model"
        }
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
          path: join(tempDir, "autorouter-manual-models.db")
        },
        trace: {
          directory: join(tempDir, "traces-manual-models"),
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
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const adapters = new AdapterRegistry();
    const stickySessions = new StickySessionStore();
    const traceStore = new TraceStore(routeTraceRepository);
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

    const createResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "manual-provider",
        display_name: "Manual Provider",
        endpoints: [
          {
            protocol: "openai-responses",
            base_url: "https://manual-models.example.com/v1"
          }
        ],
        api_key: "manual-secret",
        models: [
          {
            model_name: "Deepseek-v4-flash",
            supports_streaming: true,
            supports_tools: false,
            supports_json_mode: false
          }
        ]
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().models).toEqual([
      expect.objectContaining({
        model_key: "manual-provider/Deepseek-v4-flash",
        provider_model_id: "Deepseek-v4-flash",
        model_name: "Deepseek-v4-flash",
        supports_streaming: true
      })
    ]);
    expect(createResponse.json().accounts[0].models).toHaveLength(1);

    const modelsResponse = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer gateway-token"
      }
    });

    expect(modelsResponse.statusCode).toBe(200);
    expect(modelsResponse.json().data.map((item: { id: string }) => item.id)).toContain(
      "Deepseek-v4-flash"
    );

    await server.close();
  });

  it("updates an existing provider with manual models", async () => {
    const pool = mockAgent.get("https://manual-update.example.com");
    pool
      .intercept({
        path: "/v1/models",
        method: "GET"
      })
      .reply(200, {
        object: "list",
        data: [
          {
            id: "discovered-model",
            object: "model"
          }
        ]
      })
      .times(2);

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
          path: join(tempDir, "autorouter-manual-update.db")
        },
        trace: {
          directory: join(tempDir, "traces-manual-update"),
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
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const adapters = new AdapterRegistry();
    const stickySessions = new StickySessionStore();
    const traceStore = new TraceStore(routeTraceRepository);
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

    const createResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "manual-update",
        display_name: "Manual Update",
        endpoints: [
          {
            protocol: "openai-responses",
            base_url: "https://manual-update.example.com/v1"
          }
        ],
        api_key: "manual-secret"
      }
    });
    expect(createResponse.statusCode).toBe(201);

    const patchResponse = await server.inject({
      method: "PATCH",
      url: "/admin/api/providers/manual-update",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        models: [
          {
            model_name: "Deepseek-v4-flash",
            supports_streaming: true
          }
        ]
      }
    });

    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json().models.map((model: { model_key: string }) => model.model_key).sort()).toEqual([
      "manual-update/Deepseek-v4-flash",
      "manual-update/discovered-model",
    ]);
    expect(patchResponse.json().accounts[0].models).toHaveLength(2);

    await server.close();
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
      })
      .times(2);

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
        path: "/v1/responses",
        method: "POST"
      })
      .reply(200, {
        id: "resp_model_test",
        object: "response",
        status: "completed",
        output: []
      })
      .times(2);

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
      })
      .times(2);

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
        policies: {
          balanced: {}
        }
      }
    });

    const databaseClient = createDatabaseClient(config.database.path);
    const repository = new ManagedProviderRepository(databaseClient.db);
    const runtimeStatusService = new RuntimeStatusService(
      repository,
      new AppSettingsRepository(databaseClient.db)
    );
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const adapters = new AdapterRegistry();
    const stickySessions = new StickySessionStore();
    const traceStore = new TraceStore(routeTraceRepository);
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
      secretCipher,
      runtimeStatusService
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
        base_url: "\n https://managed.example.com/v1\t",
        website_url: "\u200Bhttps://managed.example.com \n",
        priority: 3,
        api_key: "managed-secret",
        accounts: [
          {
            account_key: "primary",
            api_key: "managed-secret",
            expires_at: "2030-01-02T03:04:05.000Z",
            quota: { remaining_usd: 12, source: "manual" },
            remark: "主用 Key",
            enabled: true
          },
          {
            account_key: "backup",
            api_key: "backup-secret",
            quota: { remaining_usd: 4, source: "manual" },
            enabled: true
          }
        ]
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().priority).toBe(3);
    expect(createResponse.json().accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_key: "primary",
          expires_at: "2030-01-02T03:04:05.000Z",
          quota: expect.objectContaining({ remaining_usd: 12 }),
          remark: "主用 Key"
        }),
        expect.objectContaining({
          account_key: "backup",
          quota: expect.objectContaining({ remaining_usd: 4 })
        })
      ])
    );
    expect(createResponse.json().accounts[0]).not.toHaveProperty("endpoint_key");
    expect(createResponse.json().models).toHaveLength(1);
    expect(createResponse.json().models[0].model_name).toBe("managed-model");
    expect(createResponse.json()).not.toHaveProperty("runtime_status");
    expect(createResponse.json()).not.toHaveProperty("status_reason");

    const updateAccountResponse = await server.inject({
      method: "PATCH",
      url: "/admin/api/providers/managed/accounts/backup",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        remark: "备用 Key"
      }
    });

    expect(updateAccountResponse.statusCode).toBe(200);
    expect(updateAccountResponse.json().accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_key: "backup",
          remark: "备用 Key"
        })
      ])
    );

    const missingEndpointResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers/managed/test-model",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        account_key: "primary",
        model_key: createResponse.json().models[0].model_key,
        prompt: "Return exactly TEST_OK."
      }
    });
    expect(missingEndpointResponse.statusCode).toBe(400);

    const testModelResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers/managed/test-model",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        account_key: "primary",
        model_key: createResponse.json().models[0].model_key,
        endpoint_key: "openai-responses",
        prompt: "Return exactly TEST_OK."
      }
    });

    expect(testModelResponse.statusCode).toBe(200);
    expect(testModelResponse.json()).toMatchObject({
      success: true,
      provider_key: "managed",
      account_key: "primary",
      model_name: "managed-model",
      prompt: "Return exactly TEST_OK.",
      protocol: "openai-responses",
      upstream_status: 200,
      error_code: null,
      error_message: null
    });
    expect(testModelResponse.json().latency_ms).toBeGreaterThanOrEqual(0);

    const testedProviderResponse = await server.inject({
      method: "GET",
      url: "/admin/api/providers/managed",
      headers: {
        authorization: "Bearer admin-token"
      }
    });
    expect(testedProviderResponse.json().account_endpoint_models).toEqual([
      expect.objectContaining({
        account_key: "primary",
        endpoint_key: "openai-responses",
        model_key: createResponse.json().models[0].model_key,
        runtime_status: "normal",
        last_success_at: expect.any(String)
      })
    ]);

    const clearObservationResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers/managed/account-endpoint-models/clear-status",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        account_key: "primary",
        endpoint_key: "openai-responses",
        model_key: createResponse.json().models[0].model_key
      }
    });
    expect(clearObservationResponse.statusCode).toBe(200);
    expect(clearObservationResponse.json().account_endpoint_models).toEqual([]);

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
    expect(listedModels).toContain("managed/openai-responses/managed-model");

    const responsesResponse = await server.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer gateway-token"
      },
      payload: {
        model: "managed-model",
        input: "hello"
      }
    });

    expect(responsesResponse.statusCode).toBe(200);
    expect(responsesResponse.json().object).toBe("response");
    expect(responsesResponse.headers["x-autorouter-normalized-model"]).toBe("auto/managed-model");

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
        priority: 8,
        base_url: "\nhttps://managed.example.com/v2 \t",
        website_url: "\u200B https://managed.example.com/docs\n"
      }
    });

    expect(editResponse.statusCode).toBe(200);
    expect(editResponse.json().display_name).toBe("Managed Provider Edited");
    expect(editResponse.json().priority).toBe(8);
    expect(editResponse.json().base_url).toBe("https://managed.example.com/v2");
    expect(editResponse.json().website_url).toBe("https://managed.example.com/docs");
    expect(editResponse.json().models).toHaveLength(1);
    expect(editResponse.json().models[0].model_name).toBe("managed-model");
    expect(editResponse.json().models[0].supports_tools).toBe(true);

    const syncResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers/managed/sync-models",
      headers: {
        authorization: "Bearer admin-token"
      }
    });
    expect(syncResponse.statusCode).toBe(200);
    expect(syncResponse.json().models).toEqual(expect.arrayContaining([
      expect.objectContaining({ model_key: "managed/managed-model" }),
      expect.objectContaining({
        model_key: "managed/managed-model-v2",
        model_name: "managed-model-v2"
      })
    ]));
    for (const account of syncResponse.json().accounts) {
      expect(account.models).toEqual([
        expect.objectContaining({ model_key: "managed/managed-model-v2" })
      ]);
    }

    const negativePriorityResponse = await server.inject({
      method: "PATCH",
      url: "/admin/api/providers/managed",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        priority: -1
      }
    });
    expect(negativePriorityResponse.statusCode).toBe(400);

    pool
      .intercept({
        path: "/anthropic/models",
        method: "GET"
      })
      .reply(200, {
        data: [
          {
            id: "claude-managed",
            type: "model",
            display_name: "Claude Managed"
          }
        ]
      });

    pool
      .intercept({
        path: "/anthropic/v1/messages",
        method: "POST"
      })
      .reply(200, {
        id: "msg_managed",
        type: "message",
        role: "assistant",
        model: "claude-managed",
        content: [
          {
            type: "text",
            text: "anthropic managed ok"
          }
        ],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 6,
          output_tokens: 4
        }
      });

    const createEndpointResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers/managed/endpoints",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        protocol: "anthropic-messages",
        base_url: "https://managed.example.com/anthropic"
      }
    });

    expect(createEndpointResponse.statusCode).toBe(201);
    expect(createEndpointResponse.json().endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_key: "openai-responses",
          protocol: "openai-responses"
        }),
        expect.objectContaining({
          endpoint_key: "anthropic-messages",
          protocol: "anthropic-messages",
        })
      ])
    );
    expect(createEndpointResponse.json().models).toEqual(syncResponse.json().models);

    const multiProtocolModelsResponse = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer gateway-token"
      }
    });
    expect(multiProtocolModelsResponse.statusCode).toBe(200);
    const multiProtocolModels = multiProtocolModelsResponse.json().data.map((item: { id: string }) => item.id);
    expect(multiProtocolModels).toContain("managed/anthropic-messages/managed-model-v2");

    const anthropicMessagesResponse = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: "Bearer gateway-token"
      },
      payload: {
        model: "managed/anthropic-messages/managed-model-v2",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(anthropicMessagesResponse.statusCode).toBe(200);
    expect(anthropicMessagesResponse.json().content[0].text).toBe("anthropic managed ok");

    const modelCapabilityResponse = await server.inject({
      method: "PATCH",
      url: "/admin/api/providers/managed/models",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        model_key: "managed/managed-model-v2",
        supports_tools: false,
        supports_json_mode: true
      }
    });

    expect(modelCapabilityResponse.statusCode).toBe(200);
    const editedModel = modelCapabilityResponse.json().models.find(
      (model: { model_key: string }) => model.model_key === "managed/managed-model-v2"
    );
    expect(editedModel.supports_tools).toBe(false);
    expect(editedModel.supports_json_mode).toBe(true);

    const apiKeysResponse = await server.inject({
      method: "GET",
      url: "/admin/api/api-keys",
      headers: {
        authorization: "Bearer admin-token"
      }
    });

    expect(apiKeysResponse.statusCode).toBe(200);
    expect(apiKeysResponse.json().system).toHaveLength(2);
    expect(apiKeysResponse.json().providers[0].provider_key).toBe("managed");

    const usageResponse = await server.inject({
      method: "GET",
      url: "/admin/api/usage",
      headers: {
        authorization: "Bearer admin-token"
      }
    });

    expect(usageResponse.statusCode).toBe(200);
    expect(usageResponse.json().totals.requests).toBe(2);
    expect(usageResponse.json().recent_requests[0].selected_provider).toBe("managed");

    const policiesResponse = await server.inject({
      method: "GET",
      url: "/admin/api/policies",
      headers: {
        authorization: "Bearer admin-token"
      }
    });

    expect(policiesResponse.statusCode).toBe(200);
    expect(policiesResponse.json().data[0].policy_id).toBe("balanced");
    expect(policiesResponse.json().data[0].is_default).toBe(true);

    const settingsResponse = await server.inject({
      method: "GET",
      url: "/admin/api/settings",
      headers: {
        authorization: "Bearer admin-token"
      }
    });

    expect(settingsResponse.statusCode).toBe(200);
    expect(settingsResponse.json().data.length).toBeGreaterThan(0);

    pool
      .intercept({
        path: "/v2/models",
        method: "GET",
        headers: {
          authorization: "Bearer late-secret"
        }
      })
      .reply(200, {
        object: "list",
        data: [
          {
            id: "late-account-model",
            object: "model"
          }
        ]
      });

    const createAccountResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers/managed/accounts",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        account_key: "late",
        api_key: "late-secret",
        enabled: true
      }
    });
    expect(createAccountResponse.statusCode).toBe(201);
    expect(
      createAccountResponse.json().accounts.find(
        (account: { account_key: string }) => account.account_key === "late"
      )?.models
    ).toEqual([
      expect.objectContaining({
        model_key: "managed/late-account-model",
        model_name: "late-account-model"
      })
    ]);

    await server.close();
  });

  it("does not fall back to Chat Completions when a Responses model test fails", async () => {
    const pool = mockAgent.get("https://admin-responses-fallback.example.com");
    pool
      .intercept({ path: "/v1/responses", method: "POST" })
      .reply(500, {
        error: {
          message: "not implemented"
        }
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
          path: join(tempDir, "autorouter-responses-fallback.db")
        },
        trace: {
          directory: join(tempDir, "traces-responses-fallback"),
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
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const adapters = new AdapterRegistry();
    const stickySessions = new StickySessionStore();
    const traceStore = new TraceStore(routeTraceRepository);
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

    repository.createProviderWithEndpointBundles({
      provider: {
        providerKey: "responses-fallback",
        displayName: "Responses Fallback",
        baseUrl: "https://admin-responses-fallback.example.com/v1"
      },
      encryptedApiKey: secretCipher.encrypt("fallback-secret"),
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "default",
            protocol: "openai-responses",
            baseUrl: "https://admin-responses-fallback.example.com/v1"
          },
          models: [
            {
              modelKey: "fallback-model",
              providerModelId: "fallback-model",
              modelName: "fallback-model",
              supportsStreaming: true,
              supportsTools: false,
              supportsJsonMode: false
            }
          ]
        }
      ]
    });

    const server = await createServer(runtimeManager, {
      managedProviderRepository: repository,
      discoveryService,
      secretCipher
    });

    const response = await server.inject({
      method: "POST",
      url: "/admin/api/providers/responses-fallback/test-model",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        account_key: "default",
        model_key: "fallback-model",
        endpoint_key: "default",
        prompt: "Return ok"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      provider_key: "responses-fallback",
      account_key: "default",
      model_key: "fallback-model",
      model_name: "fallback-model",
      protocol: "openai-responses",
      upstream_status: 500,
      error_code: "provider_error",
      error_message: "not implemented"
    });

    await server.close();
  });

  it("creates a provider with an actionable warning when model discovery fails", async () => {
    const pool = mockAgent.get("https://discovery-fails.example.com");

    pool
      .intercept({
        path: "/v1/models",
        method: "GET"
      })
      .reply(403, {
        error: { message: "forbidden" }
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
          path: join(tempDir, "autorouter-discovery-fails.db")
        },
        trace: {
          directory: join(tempDir, "traces-discovery-fails"),
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
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const adapters = new AdapterRegistry();
    const stickySessions = new StickySessionStore();
    const traceStore = new TraceStore(routeTraceRepository);
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

    const createResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "discovery-fails",
        display_name: "Discovery Fails",
        base_url: "https://discovery-fails.example.com/v1",
        api_key: "secret"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().models).toEqual([]);
    expect(createResponse.json().latest_sync).toMatchObject({
      status: "error",
      account_key: "default",
      catalog_url: null
    });
    expect(createResponse.json().latest_sync.error_message).toContain(
      "Provider model discovery failed"
    );
    expect(repository.getProviderDetails("discovery-fails")).not.toBeNull();

    await server.close();
  });

  it("rejects reserved custom headers before persisting provider endpoints", async () => {
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
          path: join(tempDir, "autorouter-reserved-headers.db")
        },
        trace: {
          directory: join(tempDir, "traces-reserved-headers"),
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
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const adapters = new AdapterRegistry();
    const stickySessions = new StickySessionStore();
    const traceStore = new TraceStore(routeTraceRepository);
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

    repository.createProviderWithEndpointBundles({
      provider: {
        providerKey: "existing",
        displayName: "Existing",
        baseUrl: "https://existing.example.com/v1"
      },
      encryptedApiKey: secretCipher.encrypt("existing-secret"),
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "default",
            protocol: "openai-responses",
            baseUrl: "https://existing.example.com/v1"
          },
          models: [
            {
              modelKey: "existing-model",
              providerModelId: "existing-model",
              modelName: "existing-model",
              supportsStreaming: true,
              supportsTools: false,
              supportsJsonMode: false
            }
          ]
        }
      ]
    });

    const server = await createServer(runtimeManager, {
      managedProviderRepository: repository,
      discoveryService,
      secretCipher
    });

    const createProviderResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "reserved-create",
        display_name: "Reserved Create",
        api_key: "secret",
        endpoints: [
          {
            protocol: "openai-responses",
            base_url: "https://reserved-create.example.com/v1",
            custom_headers: {
              authorization: "Bearer should-not-persist"
            }
          }
        ]
      }
    });

    expect(createProviderResponse.statusCode).toBe(400);
    expect(createProviderResponse.json().error.message).toContain("custom_headers 不能设置认证 header authorization");
    expect(repository.getProviderDetails("reserved-create")).toBeNull();

    const replaceProviderResponse = await server.inject({
      method: "PATCH",
      url: "/admin/api/providers/existing",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        endpoints: [
          {
            protocol: "openai-responses",
            base_url: "https://existing.example.com/v2",
            custom_headers: {
              "x-api-key": "should-not-persist"
            }
          }
        ]
      }
    });

    expect(replaceProviderResponse.statusCode).toBe(400);
    expect(replaceProviderResponse.json().error.message).toContain("custom_headers 不能设置认证 header x-api-key");
    expect(repository.getProviderEndpoint("existing", "default")?.baseUrl).toBe("https://existing.example.com/v1");

    const createEndpointResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers/existing/endpoints",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        protocol: "openai-responses",
        base_url: "https://blocked.example.com/v1",
        custom_headers: {
          Authorization: "Bearer should-not-persist"
        }
      }
    });

    expect(createEndpointResponse.statusCode).toBe(400);
    expect(createEndpointResponse.json().error.message).toContain("custom_headers 不能设置认证 header Authorization");
    expect(repository.getProviderEndpoint("existing", "blocked")).toBeNull();

    const patchEndpointResponse = await server.inject({
      method: "PATCH",
      url: "/admin/api/providers/existing/endpoints/default",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        custom_headers: {
          "X-Api-Key": "should-not-persist"
        }
      }
    });

    expect(patchEndpointResponse.statusCode).toBe(400);
    expect(patchEndpointResponse.json().error.message).toContain("custom_headers 不能设置认证 header X-Api-Key");
    expect(repository.getProviderEndpoint("existing", "default")?.customHeadersJson).toBeNull();

    await server.close();
  });

  it("creates and replaces a provider with multiple endpoints", async () => {
    const pool = mockAgent.get("https://multi.example.com");

    pool
      .intercept({
        path: "/v1/models",
        method: "GET"
      })
      .reply(200, {
        object: "list",
        data: [
          {
            id: "openai-model",
            object: "model",
            context_window: 32000,
            supports_tools: true
          }
        ]
      });

    pool
      .intercept({
        path: "/anthropic/models",
        method: "GET"
      })
      .reply(200, {
        data: [
          {
            id: "anthropic-model",
            type: "model",
            display_name: "Anthropic Model"
          }
        ]
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
            id: "openai-model-v2",
            object: "model",
            context_window: 64000
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
          path: join(tempDir, "autorouter-multi.db")
        },
        trace: {
          directory: join(tempDir, "traces-multi"),
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
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const adapters = new AdapterRegistry();
    const stickySessions = new StickySessionStore();
    const traceStore = new TraceStore(routeTraceRepository);
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

    const createResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "multi",
        display_name: "Multi Provider",
        endpoints: [
          {
            protocol: "openai-responses",
            base_url: "https://multi.example.com/v1"
          },
          {
            protocol: "anthropic-messages",
            base_url: "https://multi.example.com/anthropic"
          }
        ],
        website_url: "https://multi.example.com",
        api_key: "multi-secret"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().endpoints).toHaveLength(2);
    expect(createResponse.json().models).toEqual([
      expect.objectContaining({
        model_key: "multi/openai-model"
      })
    ]);

    const patchResponse = await server.inject({
      method: "PATCH",
      url: "/admin/api/providers/multi",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        display_name: "Multi Provider Edited",
        endpoints: [
          {
            protocol: "openai-responses",
            base_url: "https://multi.example.com/v2"
          }
        ]
      }
    });

    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json().display_name).toBe("Multi Provider Edited");
    expect(patchResponse.json().endpoints).toHaveLength(1);
    expect(patchResponse.json().endpoints[0].base_url).toBe("https://multi.example.com/v2");
    expect(patchResponse.json().models).toHaveLength(1);
    expect(patchResponse.json().models[0].model_key).toBe("multi/openai-model");

    await server.close();
  });

  it("rejects the aggregate all protocol without persisting a provider", async () => {
    const pool = mockAgent.get("https://bundle.example.com");

    pool
      .intercept({ path: "/v1/models", method: "GET" })
      .reply(200, {
        data: [{ id: "shared-model", object: "model", supports_tools: true }]
      });
    pool
      .intercept({ path: "/v1/models", method: "GET" })
      .reply(200, {
        data: [{ id: "claude-shared", type: "model" }]
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
        database: { path: join(tempDir, "autorouter-all-protocol.db") },
        trace: { directory: join(tempDir, "traces-all-protocol"), log_prompts: false },
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
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const secretCipher = new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY);
    const runtimeManager = new RuntimeManager({
      baseConfig: config,
      managedProviderRepository: repository,
      secretCipher,
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: new TraceStore(routeTraceRepository),
      logger: createLogger()
    });
    const server = await createServer(runtimeManager, {
      managedProviderRepository: repository,
      discoveryService: new ProviderModelDiscoveryService(),
      secretCipher
    });

    const createResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: { authorization: "Bearer admin-token" },
      payload: {
        provider_key: "bundle",
        display_name: "Bundle Provider",
        protocol: "all",
        base_url: "https://bundle.example.com/v1",
        api_key: "bundle-secret"
      }
    });

    expect(createResponse.statusCode).toBe(400);
    expect(repository.getProviderDetails("bundle")).toBeNull();

    await server.close();
  });

  it("rejects duplicate protocol endpoints before discovery", async () => {
    const pool = mockAgent.get("https://shared-models.example.com");

    pool
      .intercept({
        path: "/v1/models",
        method: "GET"
      })
      .reply(200, {
        object: "list",
        data: [{ id: "shared-model", object: "model", supports_tools: true }]
      });

    pool
      .intercept({
        path: "/alt/models",
        method: "GET"
      })
      .reply(503, {
        error: { message: "model list unavailable" }
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
          path: join(tempDir, "autorouter-shared-models.db")
        },
        trace: {
          directory: join(tempDir, "traces-shared-models"),
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
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const adapters = new AdapterRegistry();
    const stickySessions = new StickySessionStore();
    const traceStore = new TraceStore(routeTraceRepository);
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

    const customEndpointKeyResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "custom-endpoint-key",
        display_name: "Custom Endpoint Key",
        endpoints: [{
          endpoint_key: "custom",
          protocol: "openai-responses",
          base_url: "https://shared-models.example.com/v1"
        }],
        api_key: "shared-secret"
      }
    });
    expect(customEndpointKeyResponse.statusCode).toBe(400);
    expect(repository.getProviderDetails("custom-endpoint-key")).toBeNull();

    const createResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "shared",
        display_name: "Shared Models",
        endpoints: [
          {
            protocol: "openai-responses",
            base_url: "https://shared-models.example.com/v1"
          },
          {
            protocol: "openai-responses",
            base_url: "https://shared-models.example.com/alt"
          }
        ],
        api_key: "shared-secret"
      }
    });

    expect(createResponse.statusCode).toBe(400);
    expect(createResponse.json().error.code).toBe("duplicate_protocol");
    expect(repository.getProviderDetails("shared")).toBeNull();

    await server.close();
  });

  it("creates an anthropic provider with an anthropic default endpoint", async () => {
    const pool = mockAgent.get("https://anthropic-create.example.com");

    pool
      .intercept({
        path: "/v1/models",
        method: "GET"
      })
      .reply(200, {
        data: [
          {
            id: "claude-create",
            type: "model",
            display_name: "Claude Create"
          }
        ]
      });

    pool
      .intercept({
        path: "/v1/messages",
        method: "POST"
      })
      .reply(200, {
        id: "msg_create",
        type: "message",
        role: "assistant",
        model: "claude-create",
        content: [
          {
            type: "text",
            text: "anthropic create ok"
          }
        ],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 6,
          output_tokens: 4
        }
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
          path: join(tempDir, "autorouter-anthropic.db")
        },
        trace: {
          directory: join(tempDir, "traces-anthropic"),
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
    const routeTraceRepository = new RouteTraceRepository(databaseClient.db);
    const adapters = new AdapterRegistry();
    const stickySessions = new StickySessionStore();
    const traceStore = new TraceStore(routeTraceRepository);
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

    const createResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        provider_key: "anthropic-create",
        display_name: "Anthropic Create",
        protocol: "anthropic-messages",
        base_url: "https://anthropic-create.example.com/v1",
        website_url: "https://anthropic-create.example.com",
        api_key: "anthropic-secret"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_key: "anthropic-messages",
          protocol: "anthropic-messages",
          base_url: "https://anthropic-create.example.com/v1"
        })
      ])
    );
    expect(createResponse.json().models[0].model_key).toBe("anthropic-create/claude-create");

    const modelsResponse = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer gateway-token"
      }
    });
    expect(modelsResponse.statusCode).toBe(200);
    expect(modelsResponse.json().data.map((item: { id: string }) => item.id)).toContain(
      "claude-create"
    );

    const messagesResponse = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: "Bearer gateway-token"
      },
      payload: {
        model: "anthropic-create/claude-create",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(messagesResponse.statusCode).toBe(200);
    expect(messagesResponse.json().content[0].text).toBe("anthropic create ok");

    const protocolChangeResponse = await server.inject({
      method: "PATCH",
      url: "/admin/api/providers/anthropic-create/endpoints/anthropic-messages",
      headers: {
        authorization: "Bearer admin-token"
      },
      payload: {
        protocol: "openai-responses"
      }
    });
    expect(protocolChangeResponse.statusCode).toBe(200);
    expect(protocolChangeResponse.json().endpoints).toEqual([
      expect.objectContaining({
        endpoint_key: "openai-responses",
        protocol: "openai-responses"
      })
    ]);
    expect(repository.getProviderEndpoint("anthropic-create", "anthropic-messages")).toBeNull();

    await server.close();
  });

  it("accepts a second endpoint sharing the same base_url with a different protocol", async () => {
    // New API / sub2api 这类中转站在同一个 base URL 下同时实现两套协议：
    // /v1/chat/completions 与 /v1/messages。Admin 的「同地址加 Anthropic 入口」
    // 依赖后端允许 base_url 重复、仅以 endpoint_key 判冲突。
    const pool = mockAgent.get("https://relay-dual.example.com");

    pool
      .intercept({ path: "/v1/models", method: "GET" })
      .reply(200, {
        data: [{ id: "gpt-relay", type: "model", display_name: "GPT Relay" }]
      })
      .times(2);

    const config = loadConfig({
      override: {
        server: {
          host: "127.0.0.1",
          port: 8811,
          request_timeout_ms: 120000,
          gateway_token_env: "AUTO_ROUTER_TOKEN",
          admin_token_env: "AUTO_ROUTER_ADMIN_TOKEN"
        },
        database: { path: join(tempDir, "autorouter-relay-dual.db") },
        trace: { directory: join(tempDir, "traces-relay-dual"), log_prompts: false },
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
    const traceStore = new TraceStore(new RouteTraceRepository(databaseClient.db));
    const secretCipher = new SecretCipher(process.env.AUTO_ROUTER_MASTER_KEY);
    const runtimeManager = new RuntimeManager({
      baseConfig: config,
      managedProviderRepository: repository,
      secretCipher,
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore,
      logger: createLogger()
    });

    const server = await createServer(runtimeManager, {
      managedProviderRepository: repository,
      discoveryService: new ProviderModelDiscoveryService(),
      secretCipher
    });

    const createResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers",
      headers: { authorization: "Bearer admin-token" },
      payload: {
        provider_key: "relay-dual",
        display_name: "Relay Dual",
        protocol: "openai-responses",
        base_url: "https://relay-dual.example.com/v1",
        api_key: "relay-secret"
      }
    });
    expect(createResponse.statusCode).toBe(201);

    // 关键断言：base_url 与 default endpoint 完全相同，只有协议和 key 不同
    const addAnthropicResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers/relay-dual/endpoints",
      headers: { authorization: "Bearer admin-token" },
      payload: {
        protocol: "anthropic-messages",
        base_url: "https://relay-dual.example.com/v1"
      }
    });

    expect(addAnthropicResponse.statusCode).toBe(201);
    expect(addAnthropicResponse.json().endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_key: "openai-responses",
          protocol: "openai-responses",
          base_url: "https://relay-dual.example.com/v1"
        }),
        expect.objectContaining({
          endpoint_key: "anthropic-messages",
          protocol: "anthropic-messages",
          base_url: "https://relay-dual.example.com/v1"
        })
      ])
    );

    // 同协议只能存在一个 Endpoint
    const duplicateResponse = await server.inject({
      method: "POST",
      url: "/admin/api/providers/relay-dual/endpoints",
      headers: { authorization: "Bearer admin-token" },
      payload: {
        protocol: "anthropic-messages",
        base_url: "https://relay-dual.example.com/v1"
      }
    });
    expect(duplicateResponse.statusCode).toBe(409);

    await server.close();
  });
});
