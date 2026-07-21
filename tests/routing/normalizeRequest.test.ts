import { describe, expect, it } from "vitest";

import { normalizeChatRequest } from "../../src/routing/normalizeRequest.js";
import { HttpError } from "../../src/utils/httpErrors.js";

describe("normalizeChatRequest", () => {
  it("normalizes optional fields", () => {
    const normalized = normalizeChatRequest({
      model: "auto",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(normalized.stream).toBe(false);
    expect(normalized.tools).toEqual([]);
    expect(normalized.metadata).toEqual({});
  });

  it("rejects invalid payloads", () => {
    expect(() =>
      normalizeChatRequest({
        model: "",
        messages: []
      })
    ).toThrow(HttpError);
  });

  it("estimates context_tokens_est with heuristic tokens, not JSON length", () => {
    const messages = [{ role: "user" as const, content: "hello world ".repeat(200) }];
    const normalized = normalizeChatRequest({
      model: "auto",
      messages
    });

    expect(normalized.context_tokens_est).toBeLessThan(JSON.stringify(messages).length);
    expect(normalized.context_tokens_est).toBeGreaterThan(10);
  });

  it("honors metadata.context_tokens override", () => {
    const normalized = normalizeChatRequest({
      model: "auto",
      messages: [{ role: "user", content: "hello" }],
      metadata: { context_tokens: 4321 }
    });
    expect(normalized.context_tokens_est).toBe(4321);
  });
});
