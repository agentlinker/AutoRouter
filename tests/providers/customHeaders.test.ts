import { describe, expect, it } from "vitest";

import { pickForwardedRequestHeaders } from "../../src/providers/customHeaders.js";

describe("pickForwardedRequestHeaders", () => {
  it("forwards arbitrary end-to-end headers, including Claude client headers", () => {
    expect(pickForwardedRequestHeaders({
      "User-Agent": "claude-cli/test",
      "X-App": "cli",
      "Anthropic-Beta": ["feature-a", "feature-b"],
      "anthropic-version": "2023-06-01",
      "x-stainless-runtime": "node",
      "x-claude-code-session-id": "client-session",
      "x-future-header": "unknown-but-forwarded",
      "x-empty": "",
      "x-absent": undefined
    })).toEqual({
      "user-agent": "claude-cli/test",
      "x-app": "cli",
      "anthropic-beta": "feature-a, feature-b",
      "anthropic-version": "2023-06-01",
      "x-stainless-runtime": "node",
      "x-claude-code-session-id": "client-session",
      "x-future-header": "unknown-but-forwarded",
      "x-empty": ""
    });
  });

  it.each([
    "Authorization", "X-API-Key", "Proxy-Authorization", "Cookie", "Cookie2",
    "X-AutoRouter-Key", "x-autorouter-session-id", "x-autorouter-future",
    "Host", "Content-Length", "Content-Type", "Content-Encoding", "Accept-Encoding",
    "Connection", "Keep-Alive", "Proxy-Connection", "Proxy-Authenticate",
    "TE", "Trailer", "Transfer-Encoding", "Upgrade", "Expect", ":authority"
  ])("blocks %s regardless of casing or surrounding whitespace", (name) => {
    expect(pickForwardedRequestHeaders({ [` ${name} `]: "private" })).toBeUndefined();
  });

  it("removes Connection-nominated fields in any order and across array values", () => {
    const headers = {
      "X-First": "private",
      Connection: [" X-First, keep-alive", "x-SECOND"],
      "x-second": "private",
      "x-third": "public"
    };
    expect(pickForwardedRequestHeaders(headers)).toEqual({ "x-third": "public" });
    expect(headers["X-First"]).toBe("private");
    expect(pickForwardedRequestHeaders({ connection: "x-app", "x-app": "cli" }))
      .toBeUndefined();
    expect(pickForwardedRequestHeaders({ "x-app": "cli" })).toEqual({ "x-app": "cli" });
  });

  it("handles absent headers", () => {
    expect(pickForwardedRequestHeaders(undefined)).toBeUndefined();
    expect(pickForwardedRequestHeaders({})).toBeUndefined();
  });
});
