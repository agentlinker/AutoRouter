import { describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";

import { AnthropicAdapter } from "../../src/providers/anthropic.js";

function createRouteTarget(baseUrl: string) {
  return {
    platform: {
      id: "anthropic",
      protocol: "anthropic-messages"
    },
    provider: {
      id: "anthropic-direct",
      display_name: "Anthropic Direct",
      trust_level: "high",
      privacy_level: "normal",
      usage_trust: "high"
    },
    endpoint: {
      id: "anthropic-messages",
      provider_id: "anthropic-direct",
      platform_id: "anthropic",
      adapter: "anthropic",
      base_url: baseUrl,
      enabled: true,
      capabilities: {
        streaming: true,
        tools: true,
        json_mode: false
      },
      health: "unknown" as const,
      recent_error_count: 0
    },
    account: {
      id: "anthropic-main",
      endpoint_id: "anthropic-messages",
      account_type: "api_key",
      enabled: true,
      available: true,
      recent_error_count: 0
    },
    modelId: "claude-sonnet-direct",
    model: {
      endpoint: "anthropic-messages",
      model_name: "claude-sonnet-4-20250514",
      capabilities: {
        streaming: true,
        tools: true,
        json_mode: false
      }
    },
    credential: "anthropic-key"
  };
}

describe("AnthropicAdapter", () => {
  it.each([false, true])("preserves client headers and isolates credentials (stream=%s)", async (stream) => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    let seenHeaders: Record<string, string | string[] | undefined> = {};
    mockAgent.get("https://anthropic.example.com")
      .intercept({ path: "/v1/messages", method: "POST" })
      .reply((options) => {
        seenHeaders = (options as { headers: typeof seenHeaders }).headers;
        return { statusCode: 200, data: stream ? "event: message_stop\ndata: {}\n\n" : "{}" };
      });
    const target = {
      ...createRouteTarget("https://anthropic.example.com/v1"),
      request_headers: {
        "x-app": "cli", "anthropic-beta": "client-beta",
        "anthropic-version": "client-version",
        authorization: "Bearer gateway-key", "x-api-key": "gateway-key",
        "x-autorouter-session-id": "private", cookie: "private",
        "content-length": "99999", "content-type": "text/plain",
        "accept-encoding": "gzip", connection: "x-local", "x-local": "private"
      }
    };
    const adapter = new AnthropicAdapter();
    const body = { model: "claude", max_tokens: 1, messages: [{ role: "user", content: "Hi" }] };
    try {
      if (stream) {
        for await (const chunk of adapter.streamMessage(body, target)) {
          expect(chunk.raw).toContain("message_stop");
        }
      } else {
        await adapter.messageCompletion(body, target);
      }
      expect(seenHeaders).toMatchObject({
        "x-app": "cli", "anthropic-beta": "client-beta",
        "anthropic-version": "client-version", "x-api-key": "anthropic-key",
        "content-type": "application/json"
      });
      for (const name of ["authorization", "cookie", "x-autorouter-session-id", "x-local", "accept-encoding"]) {
        expect(seenHeaders[name]).toBeUndefined();
      }
      expect(seenHeaders["content-length"]).not.toBe("99999");
    } finally {
      await mockAgent.close();
    }
  });

  it("preserves the native Messages response and observes usage without converting it", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    const pool = mockAgent.get("https://anthropic.example.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST"
      })
      .reply(200, {
        id: "msg_123",
        content: [{ type: "text", text: "hello from anthropic" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5
        },
        stop_reason: "end_turn"
      });

    const adapter = new AnthropicAdapter();
    const response = await adapter.messageCompletion(
      {
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
        tools: [],
        metadata: {},
        context_tokens_est: 10
      },
      createRouteTarget("https://anthropic.example.com/v1")
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ content: [{ type: "text", text: "hello from anthropic" }] });
    expect(response.body).not.toHaveProperty("choices");
    expect(JSON.parse(response.raw!)).toEqual(response.body);
    expect(response.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

    await mockAgent.close();
  });

  it("preserves HTML 403 responses as endpoint access blocks", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    mockAgent
      .get("https://anthropic-blocked.example.com")
      .intercept({
        path: "/v1/messages",
        method: "POST"
      })
      .reply(403, "<!DOCTYPE html><title>Attention Required!</title>", {
        headers: { "content-type": "text/html; charset=UTF-8" }
      });

    const adapter = new AnthropicAdapter();

    await expect(
      adapter.messageCompletion(
        {
          model: "auto",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          tools: [],
          metadata: {},
          context_tokens_est: 10
        },
        createRouteTarget("https://anthropic-blocked.example.com/v1")
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "provider_access_blocked",
      retryable: true,
      message: expect.stringContaining("returned HTML with status 403")
    });

    await mockAgent.close();
  });

  it("keeps JSON 403 responses classified as API key failures", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    mockAgent
      .get("https://anthropic-auth.example.com")
      .intercept({
        path: "/v1/messages",
        method: "POST"
      })
      .reply(403, {
        error: {
          message: "invalid x-api-key"
        }
      });

    const adapter = new AnthropicAdapter();

    await expect(
      adapter.messageCompletion(
        {
          model: "auto",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          tools: [],
          metadata: {},
          context_tokens_est: 10
        },
        createRouteTarget("https://anthropic-auth.example.com/v1")
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "provider_auth_failed",
      retryable: false,
      message: "invalid x-api-key"
    });

    await mockAgent.close();
  });

  it("preserves streamed HTML 403 responses as endpoint access blocks", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    mockAgent
      .get("https://anthropic-stream-blocked.example.com")
      .intercept({
        path: "/v1/messages",
        method: "POST"
      })
      .reply(403, "<!DOCTYPE html><title>Attention Required!</title>", {
        headers: { "content-type": "text/html; charset=UTF-8" }
      });

    const adapter = new AnthropicAdapter();
    const iterator = adapter.streamMessage(
      {
        model: "auto",
        max_tokens: 8,
        messages: [{ role: "user", content: "hello" }],
        stream: true
      },
      createRouteTarget("https://anthropic-stream-blocked.example.com/v1")
    );

    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      statusCode: 403,
      code: "provider_access_blocked",
      retryable: true
    });

    await mockAgent.close();
  });

  it("preserves streamed Anthropic events byte for byte", async () => {
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    const upstream = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream","usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join("");

    const pool = mockAgent.get("https://anthropic-stream.example.com");
    pool
      .intercept({
        path: "/v1/messages",
        method: "POST"
      })
      .reply(200, upstream, {
        headers: { "content-type": "text/event-stream" }
      });

    const adapter = new AnthropicAdapter();
    const chunks: string[] = [];
    for await (const chunk of adapter.streamMessage(
      {
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        tools: [],
        metadata: {},
        context_tokens_est: 10
      },
      createRouteTarget("https://anthropic-stream.example.com/v1")
    )) {
      chunks.push(chunk.raw);
    }

    const raw = chunks.join("");
    expect(raw).toBe(upstream);

    await mockAgent.close();
  });
});
