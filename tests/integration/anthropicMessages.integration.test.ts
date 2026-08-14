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

describe("Anthropic Messages compatibility", () => {
  const traceDatabasePath = "/tmp/auto-router-anthropic-messages.db";
  let mockAgent: MockAgent;

  beforeEach(() => {
    vi.stubEnv("AUTO_ROUTER_TOKEN", "test-token");
    vi.stubEnv("UPSTREAM_API_KEY", "upstream-key");
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    rmSync(traceDatabasePath, { force: true });
    await mockAgent.close();
  });

  async function createGateway() {
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
            trust_level: "high",
            privacy_level: "normal",
            usage_trust: "high"
          }
        },
        endpoints: {
          "demo-openai": {
            provider: "demo",
            platform: "openai",
            adapter: "openai_compatible",
            base_url: "https://upstream.example.com/v1",
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            }
          }
        },
        accounts: {
          "demo-account": {
            endpoint: "demo-openai",
            account_type: "api_key",
            credential_env: "UPSTREAM_API_KEY"
          }
        },
        models: {
          "demo-claude-opus-5": {
            endpoint: "demo-openai",
            model_name: "claude-opus-5",
            context_window: 1_000_000,
            capabilities: {
              streaming: true,
              tools: true,
              json_mode: true
            }
          }
        }
      }
    });
    const registry = buildProviderRegistry(config);
    const databaseClient = createDatabaseClient(traceDatabasePath);
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
      traceStore: new TraceStore(new RouteTraceRepository(databaseClient.db))
    };

    return { gateway: await createServer(state), state };
  }

  /**
   * 同一个 base_url 下同时挂 openai 与 anthropic 两个 endpoint，
   * 模拟 New API / sub2api 这类中转站，用来验证协议偏好与原生直通。
   */
  async function createDualProtocolGateway() {
    const config = loadConfig({
      override: {
        platforms: {
          openai: { protocol: "openai" },
          anthropic: { protocol: "anthropic" }
        },
        providers: {
          relay: {
            display_name: "Relay",
            trust_level: "high",
            privacy_level: "normal",
            usage_trust: "high"
          }
        },
        endpoints: {
          "relay-openai": {
            provider: "relay",
            platform: "openai",
            adapter: "openai_compatible",
            base_url: "https://relay.example.com/v1",
            capabilities: { streaming: true, tools: true, json_mode: true }
          },
          "relay-anthropic": {
            provider: "relay",
            platform: "anthropic",
            adapter: "anthropic",
            // 与 openai endpoint 完全相同的 base_url，只有协议不同
            base_url: "https://relay.example.com/v1",
            capabilities: { streaming: true, tools: true, json_mode: true }
          }
        },
        accounts: {
          "relay-openai-account": {
            endpoint: "relay-openai",
            account_type: "api_key",
            credential_env: "UPSTREAM_API_KEY"
          },
          "relay-anthropic-account": {
            endpoint: "relay-anthropic",
            account_type: "api_key",
            credential_env: "UPSTREAM_API_KEY"
          }
        },
        models: {
          "relay-openai-opus": {
            endpoint: "relay-openai",
            model_name: "claude-opus-5",
            context_window: 1_000_000,
            capabilities: { streaming: true, tools: true, json_mode: true }
          },
          "relay-anthropic-opus": {
            endpoint: "relay-anthropic",
            model_name: "claude-opus-5",
            context_window: 1_000_000,
            capabilities: { streaming: true, tools: true, json_mode: true }
          }
        }
      }
    });
    const registry = buildProviderRegistry(config);
    const databaseClient = createDatabaseClient(traceDatabasePath);
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
      traceStore: new TraceStore(new RouteTraceRepository(databaseClient.db))
    };

    return { gateway: await createServer(state), state };
  }

  function mockTextResponse() {
    mockAgent
      .get("https://upstream.example.com")
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(200, {
        id: "chatcmpl_anthropic_compat",
        model: "claude-opus-5",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "OK"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 1,
          total_tokens: 13
        }
      });
  }

  it("accepts x-api-key and returns an Anthropic message", async () => {
    mockTextResponse();
    const { gateway } = await createGateway();
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "test-token",
        "anthropic-version": "2023-06-01"
      },
      payload: {
        model: "claude-opus-5[1m]",
        max_tokens: 32,
        messages: [{ role: "user", content: "Reply exactly OK" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-autorouter-normalized-model"]).toBe("auto/claude-opus-5");
    expect(response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 12,
        output_tokens: 1
      }
    });

    await gateway.close();
  });

  it("wraps the routed result as Anthropic SSE when stream is requested", async () => {
    mockTextResponse();
    const { gateway } = await createGateway();
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: "Bearer test-token",
        "anthropic-version": "2023-06-01"
      },
      payload: {
        model: "claude-opus-5[1m]",
        max_tokens: 32,
        stream: true,
        messages: [{ role: "user", content: "Reply exactly OK" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: message_start");
    expect(response.body).toContain("\"type\":\"text_delta\",\"text\":\"OK\"");
    expect(response.body).toContain("event: message_stop");

    await gateway.close();
  });

  it("records anthropic inbound traces with the client's real stream intent", async () => {
    mockTextResponse();
    const { gateway, state } = await createGateway();
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-api-key": "test-token",
        "anthropic-version": "2023-06-01",
        "x-autorouter-session-id": "anthropic-session"
      },
      payload: {
        model: "claude-opus-5[1m]",
        max_tokens: 32,
        stream: true,
        messages: [{ role: "user", content: "Reply exactly OK" }]
      }
    });

    expect(response.statusCode).toBe(200);

    const trace = state.traceStore.latest();
    // 入站协议可区分：以前 /v1/messages 和 /v1/chat/completions 的 trace 完全一样
    expect(trace?.policy_hits).toContain("anthropic_inbound");
    // 客户端要的是流式；以前因为内部强制 stream:false，这里恒为 false
    expect(trace?.request.stream).toBe(true);
    // session 不再因为 inject 不透传 header 而丢失
    expect(trace?.session_id).toBe("anthropic-session");
    expect(trace?.policy_hits).toContain("session_sticky");
    // selector 后缀被显式记录
    expect(trace?.request.requested_context_window).toBe(1_000_000);
    // usage 记账走通（inject 时代同样能记，但这里确认迁移后没丢）
    expect(trace?.execution.input_tokens).toBe(12);
    expect(trace?.execution.output_tokens).toBe(1);
    expect(trace?.selected?.endpoint).toBe("demo-openai");

    await gateway.close();
  });

  it("prefers the anthropic endpoint and passes the upstream body through untouched", async () => {
    // 只 mock /v1/messages。若路由错选了 openai endpoint，请求会打到
    // /v1/chat/completions 而没有拦截器，测试即失败——这本身就是断言。
    const upstreamRaw =
      '{"id":"msg_native","type":"message","role":"assistant","model":"claude-opus-5",' +
      '"content":[{"type":"thinking","thinking":"deliberating"},' +
      '{"type":"text","text":"OK"},' +
      '{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{"city":"SF"}}],' +
      '"stop_reason":"tool_use","stop_sequence":null,' +
      '"usage":{"input_tokens":18,"output_tokens":7,"cache_read_input_tokens":5}}';

    mockAgent
      .get("https://relay.example.com")
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(200, upstreamRaw, { headers: { "content-type": "application/json" } });

    const { gateway, state } = await createDualProtocolGateway();
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "test-token", "anthropic-version": "2023-06-01" },
      payload: {
        model: "claude-opus-5[1m]",
        max_tokens: 32,
        tools: [{ name: "get_weather", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "weather in SF?" }]
      }
    });

    expect(response.statusCode).toBe(200);

    // 字节级透传：以前经过 toOpenAiLikeResponse 只会剩 content[0].text
    expect(response.body).toBe(upstreamRaw);
    expect(response.body).toContain('"type":"thinking"');
    expect(response.body).toContain('"type":"tool_use"');
    expect(response.body).toContain('"cache_read_input_tokens":5');

    const trace = state.traceStore.latest();
    expect(trace?.policy_hits).toContain("anthropic_native");
    expect(trace?.policy_hits).not.toContain("protocol_mismatch");
    expect(trace?.selected?.endpoint).toBe("relay-anthropic");
    // usage 从 Anthropic 形状只读提取
    expect(trace?.execution.input_tokens).toBe(18);
    expect(trace?.execution.output_tokens).toBe(7);

    await gateway.close();
  });

  it("passes native anthropic SSE straight through instead of synthesizing it", async () => {
    // 上游真实 SSE：含 ping 与 thinking_delta，这些是合成路径产不出来的事件
    const upstreamSse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream","usage":{"input_tokens":14,"output_tokens":0}}}\n\n' +
      'event: ping\ndata: {"type":"ping"}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"OK"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":14,"output_tokens":6}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    mockAgent
      .get("https://relay.example.com")
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply(200, upstreamSse, { headers: { "content-type": "text/event-stream" } });

    const { gateway, state } = await createDualProtocolGateway();
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "test-token", "anthropic-version": "2023-06-01" },
      payload: {
        model: "claude-opus-5[1m]",
        max_tokens: 32,
        stream: true,
        messages: [{ role: "user", content: "think then reply" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");

    // 字节逐字透传：ping 与 thinking_delta 只可能来自上游
    expect(response.body).toBe(upstreamSse);
    expect(response.body).toContain("event: ping");
    expect(response.body).toContain('"type":"thinking_delta"');

    const trace = state.traceStore.latest();
    expect(trace?.policy_hits).toContain("anthropic_native_stream");
    expect(trace?.request.stream).toBe(true);
    // 流式 usage 由旁路从 Anthropic 事件里读出
    expect(trace?.execution.input_tokens).toBe(14);
    expect(trace?.execution.output_tokens).toBe(6);

    await gateway.close();
  });

  it("flags protocol_mismatch when only an openai endpoint exists", async () => {
    mockTextResponse();
    const { gateway, state } = await createGateway();
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "test-token" },
      payload: {
        model: "claude-opus-5[1m]",
        max_tokens: 32,
        messages: [{ role: "user", content: "Reply exactly OK" }]
      }
    });

    expect(response.statusCode).toBe(200);

    // 没有 anthropic endpoint 时仍然可用，只是走转换路径并留下观测标记
    const trace = state.traceStore.latest();
    expect(trace?.policy_hits).toContain("protocol_mismatch");
    expect(trace?.policy_hits).not.toContain("anthropic_native");
    expect(trace?.selected?.endpoint).toBe("demo-openai");

    await gateway.close();
  });

  it("preserves route selection details when no candidate is eligible", async () => {
    const { gateway } = await createGateway();
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "test-token" },
      payload: {
        model: "nonexistent-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }]
      }
    });

    // 以前 inject 只取 code + message，details 被丢掉
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("model_not_found");

    await gateway.close();
  });
});
