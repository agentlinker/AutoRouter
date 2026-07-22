import { describe, expect, it } from "vitest";

import { resolveEffectiveModelMetadata } from "../../src/catalog/effectiveModelMetadata.js";
import type { LogicalModelRow, ManagedModelRow } from "../../src/db/schema.js";

function managedModel(input: Partial<ManagedModelRow>): ManagedModelRow {
  return {
    id: 1,
    providerId: 1,
    endpointId: 1,
    logicalModelId: 1,
    modelKey: "provider/model",
    providerModelId: "model",
    modelName: "model",
    contextWindow: null,
    supportsStreaming: false,
    supportsTools: false,
    supportsJsonMode: false,
    pricingJson: null,
    rawMetadataJson: null,
    enabled: true,
    contextWindowOverride: null,
    supportsToolsOverride: null,
    supportsStreamingOverride: null,
    supportsJsonModeOverride: null,
    pricingJsonOverride: null,
    manualOverrideJson: null,
    discoveredAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...input
  };
}

function logicalModel(input: Partial<LogicalModelRow>): LogicalModelRow {
  return {
    id: 1,
    logicalName: "model",
    displayName: "model",
    openrouterSlug: null,
    aliasesJson: null,
    contextWindow: null,
    supportsStreaming: true,
    supportsTools: true,
    supportsJsonMode: false,
    inputModalitiesJson: null,
    pricingJson: null,
    rawMetadataJson: null,
    metadataSource: "manual",
    metadataConfidence: "low",
    notes: null,
    fetchedAt: null,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...input
  };
}

describe("resolveEffectiveModelMetadata", () => {
  it("prefers provider overrides over discovery and logical reference metadata", () => {
    const result = resolveEffectiveModelMetadata(
      managedModel({
        contextWindow: 64_000,
        supportsTools: true,
        supportsToolsOverride: false,
        pricingJson: JSON.stringify({ input_per_1m: 1 })
      }),
      logicalModel({
        contextWindow: 128_000,
        pricingJson: JSON.stringify({ input_per_1m: 2 })
      })
    );

    expect(result.contextWindow).toBe(64_000);
    expect(result.supportsTools).toBe(false);
    expect(result.pricingJson).toBe(JSON.stringify({ input_per_1m: 1 }));
  });

  it("fills sparse discovery fields from logical reference metadata", () => {
    const result = resolveEffectiveModelMetadata(
      managedModel({}),
      logicalModel({
        contextWindow: 256_000,
        supportsStreaming: true,
        supportsTools: true,
        pricingJson: JSON.stringify({ output_per_1m: 3 })
      })
    );

    expect(result.contextWindow).toBe(256_000);
    expect(result.supportsStreaming).toBe(true);
    expect(result.supportsTools).toBe(true);
    expect(result.pricingJson).toBe(JSON.stringify({ output_per_1m: 3 }));
  });
});
