import { describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";

import { OpenAiCompatibleAdapter } from "../../src/providers/openaiCompatible.js";
import { HttpError } from "../../src/utils/httpErrors.js";

function createRouteTarget(baseUrl: string) {
  return {
    platform: {
      id: "openai",
      protocol: "openai"
    },
    provider: {
      id: "demo",
      display_name: "Demo",
      trust_level: "medium",
      privacy_level: "normal",
      usage_trust: "medium"
    },
    endpoint: {
      id: "demo-openai",
      provider_id: "demo",
      platform_id: "openai",
      adapter: "openai_compatible",
      base_url: baseUrl,
      enabled: true,
      capabilities: {
        streaming: true,
        tools: true,
        json_mode: true
      },
      health: "unknown" as const,
      recent_error_count: 0
    },
    account: {
      id: "acc",
      endpoint_id: "demo-openai",
      account_type: "api_key",
      enabled: true,
      available: true,
      recent_error_count: 0
    },
    modelId: "demo-model",
    model: {
      endpoint: "demo-openai",
      model_name: "gpt-test",
      capabilities: {
        streaming: true,
        tools: true,
        json_mode: true
      }
    },
    credential: "test"
  };
}

describe("OpenAiCompatibleAdapter", () => {
  it("maps rate limit responses to retryable provider_rate_limited", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    const pool = mockAgent.get("https://adapter.example.com");
    pool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(429, {
        error: {
          message: "rate limited"
        }
      });

    const adapter = new OpenAiCompatibleAdapter();

    await expect(
      adapter.chatCompletion(
        {
          model: "auto",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          tools: [],
          metadata: {},
          context_tokens_est: 10
        },
        createRouteTarget("https://adapter.example.com/v1")
      )
    ).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryable: true
    });

    await mockAgent.close();
  });

  it("maps auth failures to non-retryable provider_auth_failed", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    const pool = mockAgent.get("https://adapter-auth.example.com");
    pool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST"
      })
      .reply(401, {
        error: {
          message: "unauthorized"
        }
      });

    const adapter = new OpenAiCompatibleAdapter();

    await expect(
      adapter.chatCompletion(
        {
          model: "auto",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          tools: [],
          metadata: {},
          context_tokens_est: 10
        },
        createRouteTarget("https://adapter-auth.example.com/v1")
      )
    ).rejects.toMatchObject({
      code: "provider_auth_failed",
      retryable: false
    });

    await mockAgent.close();
  });

  it("maps streaming responses auth failures to provider_auth_failed", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    const pool = mockAgent.get("https://adapter-stream-auth.example.com");
    pool
      .intercept({
        path: "/v1/responses",
        method: "POST"
      })
      .reply(401, {
        error: {
          message: "unauthorized"
        }
      });

    const adapter = new OpenAiCompatibleAdapter();
    const iterator = adapter.streamResponse!(
      {
        model: "auto",
        input: "hello",
        stream: true
      },
      createRouteTarget("https://adapter-stream-auth.example.com/v1")
    );

    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "provider_auth_failed",
      retryable: false
    });

    await mockAgent.close();
  });

  it("requests usage on streams and retries without stream_options on 400", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    const pool = mockAgent.get("https://adapter-stream-usage.example.com");
    const seenBodies: string[] = [];

    // 第一次带 stream_options 被拒（模拟不认该字段的中转站），第二次去掉后成功
    pool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST",
        body: (body) => {
          seenBodies.push(body);
          return body.includes("stream_options");
        }
      })
      .reply(400, { error: { message: "unknown field stream_options" } });

    pool
      .intercept({
        path: "/v1/chat/completions",
        method: "POST",
        body: (body) => {
          seenBodies.push(body);
          return !body.includes("stream_options");
        }
      })
      .reply(200, 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" }
      });

    const adapter = new OpenAiCompatibleAdapter();
    const chunks: string[] = [];
    for await (const chunk of adapter.streamChatCompletion!(
      {
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        tools: [],
        metadata: {},
        context_tokens_est: 10
      },
      createRouteTarget("https://adapter-stream-usage.example.com/v1")
    )) {
      chunks.push(chunk.raw);
    }

    // 首次请求要过 include_usage，失败后降级重试，最终仍拿到流
    expect(seenBodies[0]).toContain('"include_usage":true');
    expect(chunks.join("")).toContain("[DONE]");

    await mockAgent.close();
  });

  it("marks network failures as retryable provider_unreachable", async () => {
    const adapter = new OpenAiCompatibleAdapter();

    await expect(
      adapter.chatCompletion(
        {
          model: "auto",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          tools: [],
          metadata: {},
          context_tokens_est: 10
        },
        createRouteTarget("http://127.0.0.1:65534/v1")
      )
    ).rejects.toMatchObject({
      code: "provider_unreachable",
      retryable: true
    });
  });

  it("returns the upstream body verbatim so passthrough keeps unmodeled fields", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    // 超过 2^53 的 id 与 AutoRouter 未建模的字段：JSON 往返会破坏前者、丢弃后者
    const upstreamRaw =
      '{"id":12345678901234567890,"model":"gpt-test",' +
      '"choices":[{"index":0,"message":{"role":"assistant","content":"hi",' +
      '"reasoning_content":"thinking"},"finish_reason":"stop"}],' +
      '"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}';

    mockAgent
      .get("https://adapter-raw.example.com")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, upstreamRaw, { headers: { "content-type": "application/json" } });

    const adapter = new OpenAiCompatibleAdapter();
    const response = await adapter.chatCompletion(
      {
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
        tools: [],
        metadata: {},
        context_tokens_est: 10
      },
      createRouteTarget("https://adapter-raw.example.com/v1")
    );

    // 原始字节逐字保留，大整数未被 JSON 往返破坏
    expect(response.raw).toBe(upstreamRaw);
    expect(response.raw).toContain('"id":12345678901234567890');
    expect(response.raw).toContain('"reasoning_content":"thinking"');

    // 解析副本仅用于记账
    expect(response.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 2 });

    await mockAgent.close();
  });
});
