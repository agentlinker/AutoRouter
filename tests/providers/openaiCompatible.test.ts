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
});
