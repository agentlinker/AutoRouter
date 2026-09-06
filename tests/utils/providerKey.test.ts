import { describe, expect, it } from "vitest";

import { suggestProviderKey } from "../../src/utils/providerKey.js";

describe("suggestProviderKey", () => {
  it.each([
    ["Xiaomi Token Plan SGP", "xiaomi-token-plan-sgp"],
    ["小米模型服务", "xiao-mi-mo-xing-fu-wu"],
    ["火山方舟 Coding", "huo-shan-fang-zhou-coding"],
    ["智谱 AI", "zhi-pu-ai"]
  ])("generates an ASCII slug from display name %s", async (displayName, expected) => {
    await expect(suggestProviderKey({ displayName })).resolves.toBe(expected);
  });

  it("prefers an official template suggestion", async () => {
    await expect(
      suggestProviderKey({
        suggestedKey: "volcengine-ark-coding",
        displayName: "火山方舟 Coding",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding"
      })
    ).resolves.toBe("volcengine-ark-coding");
  });

  it("falls back to the Base URL hostname when the name is empty", async () => {
    await expect(
      suggestProviderKey({
        displayName: "",
        baseUrl: "https://api.example.com/v1"
      })
    ).resolves.toBe("api-example-com");
  });

  it("uses a stable short fallback when neither name nor URL is usable", async () => {
    await expect(
      suggestProviderKey({
        displayName: "",
        randomSuffix: "a1b2c3"
      })
    ).resolves.toBe("provider-a1b2c3");
  });
});
