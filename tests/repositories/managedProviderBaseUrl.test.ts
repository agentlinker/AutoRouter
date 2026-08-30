import { describe, expect, it } from "vitest";

import { normalizeBaseUrlForMerge } from "../../src/repositories/managedProviderRepository.js";

describe("normalizeBaseUrlForMerge", () => {
  it("treats a root URL and its trailing v1 path as the same base URL", () => {
    expect(normalizeBaseUrlForMerge("https://api.example.com")).toBe(
      normalizeBaseUrlForMerge("https://api.example.com/v1/")
    );
    expect(normalizeBaseUrlForMerge("https://api.example.com/api/coding")).toBe(
      normalizeBaseUrlForMerge("https://api.example.com/api/coding/v1")
    );
  });

  it("preserves protocol, port, and non-version path differences", () => {
    expect(normalizeBaseUrlForMerge("https://api.example.com/openai/v1")).not.toBe(
      normalizeBaseUrlForMerge("https://api.example.com/anthropic")
    );
    expect(normalizeBaseUrlForMerge("https://api.example.com/tenant-a/v1")).not.toBe(
      normalizeBaseUrlForMerge("https://api.example.com/tenant-b/v1")
    );
    expect(normalizeBaseUrlForMerge("http://api.example.com/v1")).not.toBe(
      normalizeBaseUrlForMerge("https://api.example.com/v1")
    );
    expect(normalizeBaseUrlForMerge("https://api.example.com:8443/v1")).not.toBe(
      normalizeBaseUrlForMerge("https://api.example.com/v1")
    );
  });
});
