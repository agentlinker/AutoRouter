import { describe, expect, it } from "vitest";

import { toLogicalModelName } from "../../src/catalog/logicalModelNames.js";

describe("toLogicalModelName", () => {
  it.each([
    ["grok4.5", "grok-4.5"],
    ["grok-4.5", "grok-4.5"],
    ["Grok 4.5", "grok-4.5"],
    ["Grok-4.5", "grok-4.5"],
    ["xai/grok-4.5", "grok-4.5"],
    ["openai:grok-4.5", "grok-4.5"],
    ["anthropic/claude-opus-4.7", "claude-opus-4.7"]
  ])("normalizes %s to %s", (input, expected) => {
    expect(toLogicalModelName(input)).toBe(expected);
  });
});
