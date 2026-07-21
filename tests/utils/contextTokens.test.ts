import { describe, expect, it } from "vitest";

import {
  estimateChatContextTokens,
  estimateResponsesContextTokens,
  estimateTextTokens,
  readExplicitContextTokens
} from "../../src/utils/contextTokens.js";

describe("contextTokens", () => {
  it("prefers explicit metadata context tokens", () => {
    expect(
      estimateChatContextTokens({
        messages: [{ role: "user", content: "hello world ".repeat(1000) }],
        metadata: { context_tokens: 1234 }
      })
    ).toBe(1234);

    expect(readExplicitContextTokens({ prompt_tokens: 88 })).toBe(88);
  });

  it("estimates latin text much lower than raw character length", () => {
    const text = "hello world ";
    const repeated = text.repeat(1000);
    const estimated = estimateTextTokens(repeated);
    expect(estimated).toBeLessThan(repeated.length / 2);
    expect(estimated).toBeGreaterThan(100);
  });

  it("does not use raw JSON string length for chat estimates", () => {
    const messages = [
      {
        role: "user",
        content: "hello world ".repeat(500)
      }
    ];
    const rawJsonLength = JSON.stringify(messages).length;
    const estimated = estimateChatContextTokens({ messages });
    expect(estimated).toBeLessThan(rawJsonLength);
  });

  it("counts image parts with a fixed budget", () => {
    const estimated = estimateResponsesContextTokens({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: "https://example.com/a.png" }
          ]
        }
      ]
    });
    expect(estimated).toBeGreaterThanOrEqual(765);
  });

  it("includes tools in responses estimates", () => {
    const withoutTools = estimateResponsesContextTokens({
      input: "hello"
    });
    const withTools = estimateResponsesContextTokens({
      input: "hello",
      tools: [
        {
          type: "function",
          name: "search_docs",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "search query text ".repeat(20) }
            }
          }
        }
      ]
    });
    expect(withTools).toBeGreaterThan(withoutTools);
  });
});
