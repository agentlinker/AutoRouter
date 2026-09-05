import { describe, expect, it } from "vitest";

import { platformSchema } from "../../src/config/schema.js";
import { loadConfig } from "../../src/config/loadConfig.js";

describe("wire protocol configuration", () => {
  it.each(["openai-responses", "openai-chat-completions", "anthropic-messages"])(
    "accepts the explicit %s protocol without rewriting it",
    (protocol) => {
      expect(platformSchema.parse({ protocol }).protocol).toBe(protocol);
      const config = loadConfig({ override: {
        providers: { demo: { protocol, base_url: "https://example.com/v1" } }
      } });
      expect(config.platforms[protocol].protocol).toBe(protocol);
    }
  );

  it.each(["openai", "anthropic", "all", "unknown"])(
    "rejects %s in expanded and shorthand configuration",
    (protocol) => {
      expect(platformSchema.safeParse({ protocol }).success).toBe(false);
      expect(() => loadConfig({ override: {
        providers: { demo: { protocol, base_url: "https://example.com/v1" } }
      } })).toThrow();
    }
  );
});
