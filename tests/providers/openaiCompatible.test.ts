import { describe, expect, it, vi } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";

import { OpenAiCompatibleAdapter } from "../../src/providers/openaiCompatible.js";
import { HttpError } from "../../src/utils/httpErrors.js";

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
          metadata: {}
        },
        {
          endpointId: "demo-openai",
          platformId: "demo",
          accountId: "acc",
          model: "gpt-test",
          endpointConfig: {
            platform: "demo",
            protocol: "openai_compatible",
            base_url: "https://adapter.example.com/v1",
            enabled: true,
            accounts: [
              {
                id: "acc",
                account_type: "api_key",
                api_key_env: "DEMO_API_KEY",
                enabled: true
              }
            ]
          },
          apiKey: "test"
        }
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
          metadata: {}
        },
        {
          endpointId: "demo-openai",
          platformId: "demo",
          accountId: "acc",
          model: "gpt-test",
          endpointConfig: {
            platform: "demo",
            protocol: "openai_compatible",
            base_url: "https://adapter-auth.example.com/v1",
            enabled: true,
            accounts: [
              {
                id: "acc",
                account_type: "api_key",
                api_key_env: "DEMO_API_KEY",
                enabled: true
              }
            ]
          },
          apiKey: "test"
        }
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
          metadata: {}
        },
        {
          endpointId: "demo-openai",
          platformId: "demo",
          accountId: "acc",
          model: "gpt-test",
          endpointConfig: {
            platform: "demo",
            protocol: "openai_compatible",
            base_url: "http://127.0.0.1:65534/v1",
            enabled: true,
            accounts: [
              {
                id: "acc",
                account_type: "api_key",
                api_key_env: "DEMO_API_KEY",
                enabled: true
              }
            ]
          },
          apiKey: "test"
        }
      )
    ).rejects.toMatchObject({
      code: "provider_unreachable",
      retryable: true
    });
  });
});
