import { describe, expect, it } from "vitest";

import { resolveUpstreamUrl } from "../../src/providers/upstreamUrl.js";

describe("resolveUpstreamUrl", () => {
  it.each([
    ["https://api.example.com", "messages", "https://api.example.com/v1/messages"],
    ["https://api.example.com/v1", "messages", "https://api.example.com/v1/messages"],
    ["https://api.example.com/v1/messages", "messages", "https://api.example.com/v1/messages"],
    ["https://api.example.com", "chat_completions", "https://api.example.com/v1/chat/completions"],
    ["https://api.example.com/v1", "chat_completions", "https://api.example.com/v1/chat/completions"],
    [
      "https://api.example.com/v1/chat/completions",
      "chat_completions",
      "https://api.example.com/v1/chat/completions"
    ],
    ["https://api.example.com", "responses", "https://api.example.com/v1/responses"],
    ["https://api.example.com/v1", "responses", "https://api.example.com/v1/responses"],
    ["https://api.example.com/v1/responses", "responses", "https://api.example.com/v1/responses"],
    [
      "https://api.example.com/api/coding",
      "messages",
      "https://api.example.com/api/coding/v1/messages"
    ],
    [
      "https://api.example.com/openai/",
      "chat_completions",
      "https://api.example.com/openai/v1/chat/completions"
    ]
  ] as const)("resolves %s for %s", (baseUrl, operation, expected) => {
    expect(resolveUpstreamUrl(baseUrl, operation)).toBe(expected);
  });

  it("rewrites an explicitly configured complete operation URL to the requested operation", () => {
    expect(
      resolveUpstreamUrl("https://api.example.com/v1/chat/completions?region=us", "responses")
    ).toBe("https://api.example.com/v1/responses?region=us");
    expect(
      resolveUpstreamUrl("https://api.example.com/v1/responses?region=us", "chat_completions")
    ).toBe("https://api.example.com/v1/chat/completions?region=us");
  });

  it("preserves a custom prefix when rewriting complete operation URLs", () => {
    expect(
      resolveUpstreamUrl(
        "https://ark.example.com/api/coding/v3/chat/completions",
        "responses"
      )
    ).toBe("https://ark.example.com/api/coding/v3/responses");
  });
});
