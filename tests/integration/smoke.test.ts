import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { MockAgent, setGlobalDispatcher } from "undici";

import { buildProviderRegistry } from "../../src/catalog/providerRegistry.js";
import { PriceTable } from "../../src/catalog/priceTable.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { createDatabaseClient } from "../../src/db/client.js";
import { AdapterRegistry } from "../../src/providers/registry.js";
import { RouteTraceRepository } from "../../src/repositories/routeTraceRepository.js";
import { StickySessionStore } from "../../src/routing/stickySession.js";
import { createServer } from "../../src/server/createServer.js";
import type { RouterState } from "../../src/state/routerState.js";
import { TraceStore } from "../../src/trace/traceStore.js";
import { createLogger } from "../../src/utils/logger.js";

describe("local smoke", () => {
  let mockAgent: MockAgent;

  function createTraceStore(databasePath: string) {
    const databaseClient = createDatabaseClient(databasePath);
    return new TraceStore(new RouteTraceRepository(databaseClient.db));
  }

  beforeEach(() => {
    vi.stubEnv("AUTO_ROUTER_TOKEN", "smoke-token");
    vi.stubEnv("SMOKE_API_KEY", "smoke-api-key");
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    rmSync("/tmp/auto-router-smoke-traces.db", { force: true });
    await mockAgent.close();
  });

  it("serves health, models, explain, and chat completion together", async () => {
    const pool = mockAgent.get("https://smoke.example.com");
    pool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(200, {
        id: "chatcmpl_smoke",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "smoke-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "smoke ok"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12
        }
      });

    pool
      .intercept({
        path: "/v1/models",
        method: "GET"
      })
      .reply(200, {
        object: "list",
        data: [{ id: "smoke-model", object: "model", owned_by: "smoke" }]
      });

    const config = loadConfig({
      override: {
        platforms: {
          openai: {
            protocol: "openai"
          }
        },
        providers: {
          smoke: {
            display_name: "Smoke",
            trust_level: "medium",
            privacy_level: "normal",
            usage_trust: "medium"
          }
        },
        endpoints: {
          "smoke-openai": {
            provider: "smoke",
            platform: "openai",
            adapter: "openai_compatible",
            base_url: "https://smoke.example.com/v1",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            }
          }
        },
        accounts: {
          "smoke-account": {
            endpoint: "smoke-openai",
            account_type: "api_key",
            credential_env: "SMOKE_API_KEY"
          }
        },
        models: {
          "smoke-model": {
            endpoint: "smoke-openai",
            model_name: "smoke-model",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            }
          }
        },
        routes: {
          auto: {
            policy: "balanced",
            candidates: [
              {
                account: "smoke-account",
                model: "smoke-model"
              }
            ]
          }
        },
        policies: {
          balanced: {
            min_trust_level: "medium",
            allow_public_only_provider: false,
            fallback_enabled: true,
            sticky_session: true
          }
        }
      }
    });

    const registry = buildProviderRegistry(config);
    const state: RouterState = {
      config,
      logger: createLogger(),
      platforms: registry.platforms,
      providers: registry.providers,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: new AdapterRegistry(),
      stickySessions: new StickySessionStore(),
      traceStore: createTraceStore("/tmp/auto-router-smoke-traces.db")
    };

    const gateway = await createServer(state);

    const healthResponse = await gateway.inject({
      method: "GET",
      url: "/v1/autorouter/health",
      headers: {
        authorization: "Bearer smoke-token"
      }
    });
    expect(healthResponse.statusCode).toBe(200);

    const modelsResponse = await gateway.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer smoke-token"
      }
    });
    expect(modelsResponse.statusCode).toBe(200);

    const chatResponse = await gateway.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer smoke-token"
      },
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "hello" }]
      }
    });
    expect(chatResponse.statusCode).toBe(200);

    pool
      .intercept({
        path: "/v1/responses",
        method: "POST"
      })
      .reply(200, {
        id: "resp_responses_smoke",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: "smoke-model",
        output: [
          {
            id: "msg_responses_smoke",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "responses ok", annotations: [] }]
          }
        ],
        output_text: "responses ok",
        usage: {
          input_tokens: 8,
          output_tokens: 4,
          total_tokens: 12
        }
      });

    const responsesResponse = await gateway.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer smoke-token"
      },
      payload: {
        model: "auto",
        input: "hello from responses"
      }
    });
    expect(responsesResponse.statusCode).toBe(200);
    expect(responsesResponse.json()).toMatchObject({
      object: "response",
      status: "completed",
      output_text: "responses ok"
    });

    pool
      .intercept({
        path: "/v1/responses",
        method: "POST"
      })
      .reply(
        200,
        [
          "event: response.completed",
          "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stream\",\"status\":\"completed\"}}",
          "",
          "data: [DONE]",
          ""
        ].join("\n"),
        {
          headers: {
            "content-type": "text/event-stream; charset=utf-8"
          }
        }
      );

    const responsesStreamResponse = await gateway.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer smoke-token"
      },
      payload: {
        model: "auto",
        input: "hello from streaming responses",
        stream: true
      }
    });
    expect(responsesStreamResponse.statusCode).toBe(200);
    expect(responsesStreamResponse.headers["content-type"]).toContain("text/event-stream");
    expect(responsesStreamResponse.body).toContain("event: response.completed");
    expect(responsesStreamResponse.body).toContain('"type":"response.completed"');

    pool
      .intercept({
        path: "/v1/responses",
        method: "POST"
      })
      .reply(200, (options) => {
        const body = JSON.parse(String(options.body)) as {
          input: Array<{ type: string; call_id?: string; name?: string; output?: string }>;
        };
        expect(body.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "function_call",
              call_id: "fc_test",
              name: "lookup"
            }),
            expect.objectContaining({
              type: "function_call_output",
              call_id: "fc_test",
              output: "lookup result"
            })
          ])
        );

        return {
          id: "resp_responses_tool_smoke",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model: "smoke-model",
          output: [
            {
              id: "msg_responses_tool_smoke",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "tool response ok", annotations: [] }]
            }
          ],
          output_text: "tool response ok",
          usage: {
            input_tokens: 12,
            output_tokens: 4,
            total_tokens: 16
          }
        };
      });

    const responsesToolResponse = await gateway.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: "Bearer smoke-token"
      },
      payload: {
        model: "auto",
        input: [
          {
            type: "message",
            role: "user",
            content: "call lookup"
          },
          {
            type: "function_call",
            call_id: "fc_test",
            name: "lookup",
            arguments: "{\"query\":\"hello\"}"
          },
          {
            type: "function_call_output",
            call_id: "fc_test",
            output: "lookup result"
          }
        ]
      }
    });
    expect(responsesToolResponse.statusCode).toBe(200);
    expect(responsesToolResponse.json()).toMatchObject({
      output_text: "tool response ok"
    });

    const explainResponse = await gateway.inject({
      method: "GET",
      url: "/v1/autorouter/explain/latest",
      headers: {
        authorization: "Bearer smoke-token"
      }
    });
    expect(explainResponse.statusCode).toBe(200);

    await gateway.close();
  });
});
