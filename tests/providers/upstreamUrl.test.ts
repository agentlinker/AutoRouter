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

  it("uses an explicitly configured complete operation URL unchanged", () => {
    expect(
      resolveUpstreamUrl("https://api.example.com/v1/chat/completions?region=us", "responses")
    ).toBe("https://api.example.com/v1/chat/completions?region=us");
  });
});
