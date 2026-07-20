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
import { RouteTraceRepository } from "../../src/repositories/routeTraceRepository.js";
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
    expect(editResponse.json().models[0].supports_tools).toBe(true);

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
        path: "/anthropic/messages",
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
        endpoint_key: "anthropic",
        protocol: "anthropic",
        adapter_type: "anthropic",
        base_url: "https://managed.example.com/anthropic"
      }
    });

    expect(createEndpointResponse.statusCode).toBe(201);
    expect(createEndpointResponse.json().endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_key: "default",
          protocol: "openai"
        }),
        expect.objectContaining({
          endpoint_key: "anthropic",
          protocol: "anthropic",
          adapter_type: "anthropic"
        })
      ])
    );
    expect(createEndpointResponse.json().models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model_key: "managed/anthropic/claude-managed",
          endpoint_key: "anthropic",
          model_name: "claude-managed"
        })
      ])
    );

    const multiProtocolModelsResponse = await server.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer gateway-token"
      }
    });
    expect(multiProtocolModelsResponse.statusCode).toBe(200);
    const multiProtocolModels = multiProtocolModelsResponse.json().data.map((item: { id: string }) => item.id);
    expect(multiProtocolModels).toContain("managed/anthropic/claude-managed");

    const anthropicChatResponse = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer gateway-token"
      },
      payload: {
        model: "managed/anthropic/claude-managed",
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(anthropicChatResponse.statusCode).toBe(200);
    expect(anthropicChatResponse.json().choices[0].message.content).toBe("anthropic managed ok");

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
            endpoint_key: "default",
            protocol: "openai",
            base_url: "https://multi.example.com/v1"
          },
          {
            endpoint_key: "anthropic",
            protocol: "anthropic",
            base_url: "https://multi.example.com/anthropic"
          }
        ],
        website_url: "https://multi.example.com",
        api_key: "multi-secret"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().endpoints).toHaveLength(2);
    expect(createResponse.json().models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model_key: "multi/openai-model",
          endpoint_key: "default"
        }),
        expect.objectContaining({
          model_key: "multi/anthropic/anthropic-model",
          endpoint_key: "anthropic"
        })
      ])
    );

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
            endpoint_key: "default",
            protocol: "openai",
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
    expect(patchResponse.json().models[0].model_key).toBe("multi/openai-model-v2");

    await server.close();
  });

  it("reuses provider models for endpoints that cannot list models", async () => {
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

    pool
      .intercept({
        path: "/alt/chat/completions",
        method: "POST"
      })
      .reply(200, (options) => {
        const body = JSON.parse(String(options.body)) as { model: string };
        expect(body.model).toBe("shared-model");

        return {
          id: "chatcmpl_shared_alt",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "shared-model",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "shared alt ok"
              },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 4,
            total_tokens: 9
          }
        };
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
            endpoint_key: "default",
            protocol: "openai",
            base_url: "https://shared-models.example.com/v1"
          },
          {
            endpoint_key: "alt",
            protocol: "openai",
            base_url: "https://shared-models.example.com/alt"
          }
        ],
        api_key: "shared-secret"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().models).toEqual([
      expect.objectContaining({
        model_key: "shared/shared-model",
        endpoint_key: "default"
      })
    ]);

    const chatResponse = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer gateway-token"
      },
      payload: {
        model: "shared/alt/shared-model",
        messages: [{ role: "user", content: "use alt endpoint" }]
      }
    });

    expect(chatResponse.statusCode).toBe(200);
    expect(chatResponse.json().choices[0].message.content).toBe("shared alt ok");

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
        protocol: "anthropic",
        base_url: "https://anthropic-create.example.com/v1",
        website_url: "https://anthropic-create.example.com",
        api_key: "anthropic-secret"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_key: "default",
          protocol: "anthropic",
          adapter_type: "anthropic",
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
      "anthropic-create/claude-create"
    );

    const chatResponse = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer gateway-token"
      },
      payload: {
        model: "anthropic-create/claude-create",
        messages: [{ role: "user", content: "hello" }]
      }
    });

    expect(chatResponse.statusCode).toBe(200);
    expect(chatResponse.json().choices[0].message.content).toBe("anthropic create ok");

    await server.close();
  });
});
