import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getOfficialProviderTemplate,
  listOfficialProviderTemplates,
  listOfficialProviderTemplatesByVendor
} from "../../src/providers/officialProviderTemplates.js";
import { loadProviderTemplates } from "../../src/providers/providerTemplateLoader.js";

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
      expect(["official", "relay", "custom"]).toContain(template.provider_kind);
      expect(template.endpoints.length).toBeGreaterThan(0);
      expect(template.suggested_provider_key.length).toBeGreaterThan(0);
    }

    expect(getOfficialProviderTemplate("openrouter")?.provider_kind).toBe("relay");
    expect(getOfficialProviderTemplate("ollama-local")?.provider_kind).toBe("custom");
  });

  it("loads user templates and replaces bundled ids", () => {
    const cwd = mkdtempSync(join(tmpdir(), "autorouter-template-test-"));
    try {
      mkdirSync(join(cwd, "config"));
      writeFileSync(
        join(cwd, "config/provider-templates.yaml"),
        "templates:\n  - template_id: base\n    vendor_id: base\n    vendor_name: Base\n    product_line: API\n    display_name: Base\n    suggested_provider_key: base\n    provider_kind: official\n    model_availability_scope: shared_by_provider\n    endpoints:\n      - endpoint_key: openai\n        protocol: openai\n        base_url: https://base.example.com/v1\n"
      );
      writeFileSync(
        join(cwd, "config/provider-templates.user.yaml"),
        "templates:\n  - template_id: base\n    vendor_id: user\n    vendor_name: User\n    product_line: Relay\n    display_name: User Base\n    suggested_provider_key: user-base\n    provider_kind: relay\n    model_availability_scope: per_account\n    endpoints:\n      - endpoint_key: openai\n        protocol: openai\n        base_url: https://user.example.com/v1\n  - template_id: extra\n    vendor_id: extra\n    vendor_name: Extra\n    product_line: Custom\n    display_name: Extra\n    suggested_provider_key: extra\n    provider_kind: custom\n    model_availability_scope: per_account\n    endpoints:\n      - endpoint_key: openai\n        protocol: openai\n        base_url: https://extra.example.com/v1\n"
      );
      const result = loadProviderTemplates(cwd);
      expect(result.errors).toEqual([]);
      expect(result.templates.map((item) => item.template_id)).toEqual(["base", "extra"]);
      expect(result.templates[0].provider_kind).toBe("relay");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
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
