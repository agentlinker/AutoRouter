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
});
