import { describe, expect, it } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";

import { AnthropicAdapter } from "../../src/providers/anthropic.js";

function createRouteTarget(baseUrl: string) {
  return {
    platform: {
      id: "anthropic",
      protocol: "anthropic"
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
  it("translates anthropic messages response into OpenAI-like chat completion", async () => {
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
    const response = await adapter.chatCompletion(
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
    expect((response.body as { choices: Array<{ message: { content: string } }> }).choices[0].message.content).toBe(
      "hello from anthropic"
    );

    await mockAgent.close();
  });

  it("translates streamed anthropic events into OpenAI chat completion chunks", async () => {
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
    for await (const chunk of adapter.streamChatCompletion!(
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
    // 关键断言：客户端拿到的是 OpenAI 格式，而不是 Anthropic 原始事件
    expect(raw).toContain('"object":"chat.completion.chunk"');
    expect(raw).not.toContain("content_block_delta");
    expect(raw).not.toContain("message_start");
    expect(raw.endsWith("data: [DONE]\n\n")).toBe(true);

    const events = raw
      .split("\n\n")
      .map((segment) => segment.replace(/^data: /, "").trim())
      .filter((payload) => payload.length > 0 && payload !== "[DONE]")
      .map((payload) => JSON.parse(payload) as {
        choices: Array<{ delta: { content?: string }; finish_reason: string | null }>;
        usage?: { total_tokens?: number };
      });

    expect(events.map((event) => event.choices[0].delta.content ?? "").join("")).toBe("hi");
    expect(events.at(-1)?.choices[0].finish_reason).toBe("stop");
    expect(events.at(-1)?.usage?.total_tokens).toBe(9);

    await mockAgent.close();
  });
});
