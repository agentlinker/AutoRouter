import { describe, expect, it } from "vitest";

import { AdapterRegistry } from "../../src/providers/registry.js";

describe("protocol-specific adapters", () => {
  it.each([
    ["openai-responses", "responseCompletion", "streamResponse"],
    ["openai-chat-completions", "chatCompletion", "streamChatCompletion"],
    ["anthropic-messages", "messageCompletion", "streamMessage"]
  ] as const)("exposes only native operations for %s", (protocol, completion, stream) => {
    const adapter = new AdapterRegistry().forProtocol(protocol);
    expect(adapter).toHaveProperty("protocol", protocol);
    for (const operation of ["responseCompletion", "streamResponse", "chatCompletion",
      "streamChatCompletion", "messageCompletion", "streamMessage"]) {
      expect(operation in adapter).toBe(operation === completion || operation === stream);
    }
  });

  it.each(["openai", "anthropic", "all", "unknown"])("rejects %s instead of selecting a fallback adapter", (protocol) => {
    expect(() => new AdapterRegistry().forProtocol(protocol)).toThrow();
  });
});
