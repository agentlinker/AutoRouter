import { describe, expect, it } from "vitest";

import { toLogicalModelName } from "../../src/catalog/logicalModelNames.js";

describe("toLogicalModelName", () => {
  it.each([
    ["grok-4.5", "grok-4.5"],
    ["Grok-4.5", "grok-4.5"],
    ["Grok 4.5", "grok-4.5"],
    ["grok_4.5", "grok-4.5"],
    ["xai/grok-4.5", "grok-4.5"],
    ["openai:grok-4.5", "grok-4.5"],
    ["anthropic/claude-opus-4.7", "claude-opus-4.7"],
    ["  grok-4.5  ", "grok-4.5"],
    ["grok--4.5", "grok-4.5"],
    ["-grok-4.5-", "grok-4.5"]
  ])("normalizes %s to %s", (input, expected) => {
    expect(toLogicalModelName(input)).toBe(expected);
  });

  // 字母与数字之间不再插入分隔符：上游/官方命名里的 v4、qwen3 是整体。
  it.each([
    ["deepseek-v4-pro", "deepseek-v4-pro"],
    ["deepseek-ai/deepseek-v4-pro", "deepseek-v4-pro"],
    ["openai:deepseek-v4-pro", "deepseek-v4-pro"],
    ["deepseek-v4-flash-260425", "deepseek-v4-flash-260425"],
    ["qwen3-235b", "qwen3-235b"],
    ["gpt-4o", "gpt-4o"],
    ["magnum-v4-72b", "magnum-v4-72b"]
  ])("keeps letter-digit boundaries in %s", (input, expected) => {
    expect(toLogicalModelName(input)).toBe(expected);
  });

  // 粘连写法保持原样，不再被改写成带横线的形式。
  it("leaves glued names untouched instead of guessing separators", () => {
    expect(toLogicalModelName("grok4.5")).toBe("grok4.5");
  });
});
