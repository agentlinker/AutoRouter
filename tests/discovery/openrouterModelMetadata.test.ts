import { describe, expect, it } from "vitest";

import { OpenRouterModelMetadataService, type OpenRouterModelMetadata } from "../../src/discovery/openrouterModelMetadata.js";

describe("OpenRouterModelMetadataService", () => {
  it("matches logical model names across separator differences", () => {
    const service = new OpenRouterModelMetadataService();
    const models: OpenRouterModelMetadata[] = [
      {
        id: "anthropic/claude-opus-4.7",
        name: "Claude Opus 4.7",
        raw: {}
      }
    ];

    const result = service.matchModel(models, {
      logicalName: "claude-opus-4-7"
    });

    expect(result.match?.id).toBe("anthropic/claude-opus-4.7");
  });

  it("ignores provider namespace when canonical matching OpenRouter ids", () => {
    const service = new OpenRouterModelMetadataService();
    const models: OpenRouterModelMetadata[] = [
      {
        id: "custom/vendor/claude-opus-4.7",
        name: "Vendor Claude Opus 4.7",
        raw: {}
      }
    ];

    const result = service.matchModel(models, {
      logicalName: "claude-opus-4-7"
    });

    expect(result.match?.id).toBe("custom/vendor/claude-opus-4.7");
  });

  it("prefers exact basename canonical matches over named variants", () => {
    const service = new OpenRouterModelMetadataService();
    const models: OpenRouterModelMetadata[] = [
      {
        id: "anthropic/claude-opus-4.7-fast",
        name: "Claude Opus 4.7 Fast",
        raw: {}
      },
      {
        id: "anthropic/claude-opus-4.7",
        name: "Claude Opus 4.7",
        raw: {}
      }
    ];

    const result = service.matchModel(models, {
      logicalName: "claude-opus-4-7"
    });

    expect(result.match?.id).toBe("anthropic/claude-opus-4.7");
  });
});
