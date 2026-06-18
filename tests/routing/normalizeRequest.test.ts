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
});
