import { describe, expect, it } from "vitest";

import {
  getOfficialProviderTemplate,
  listOfficialProviderTemplates,
  listOfficialProviderTemplatesByVendor
} from "../../src/providers/officialProviderTemplates.js";

describe("officialProviderTemplates", () => {
  it("presets known official vendors extracted from local managed providers", () => {
    const templates = listOfficialProviderTemplates();
    const ids = templates.map((item) => item.template_id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "bigmodel-paas-cn",
        "xiaomi-mimo-token-plan-cn",
        "xiaomi-mimo-token-plan-sgp",
        "volcengine-ark-coding-cn-beijing",
        "longcat-official"
      ])
    );

    for (const template of templates) {
      expect(template.provider_kind).toBe("official");
      expect(template.model_availability_scope).toBe("shared_by_provider");
      expect(template.endpoints.length).toBeGreaterThan(0);
      expect(template.suggested_provider_key.length).toBeGreaterThan(0);
    }
  });

  it("splits the same vendor into region or product templates", () => {
    const xiaomi = listOfficialProviderTemplatesByVendor("xiaomi-mimo");
    expect(xiaomi).toHaveLength(2);
    expect(xiaomi.map((item) => item.region).sort()).toEqual(["cn", "sgp"]);
  });

  it("returns a cloned template by id", () => {
    const template = getOfficialProviderTemplate("bigmodel-paas-cn");
    expect(template?.display_name).toBe("智谱官方");
    expect(template?.endpoints.map((item) => item.endpoint_key).sort()).toEqual([
      "anthropic",
      "openai"
    ]);

    if (!template) {
      throw new Error("expected template");
    }
    template.display_name = "mutated";
    expect(getOfficialProviderTemplate("bigmodel-paas-cn")?.display_name).toBe("智谱官方");
  });
});
