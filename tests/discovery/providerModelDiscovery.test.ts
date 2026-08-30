import { describe, expect, it, vi } from "vitest";

import {
  ProviderModelDiscoveryService,
  deriveModelCatalogUrls
} from "../../src/discovery/providerModelDiscovery.js";

describe("provider model catalog discovery", () => {
  it("derives one OpenAI catalog without duplicating the version segment", () => {
    expect(deriveModelCatalogUrls([
      {
        endpointKey: "openai",
        protocol: "openai",
        baseUrl: "https://example.com/v1/"
      },
      {
        endpointKey: "anthropic",
        protocol: "anthropic",
        baseUrl: "https://example.com/anthropic"
      }
    ])).toEqual(["https://example.com/v1/models"]);
  });

  it("derives stable Anthropic fallback candidates when OpenAI is absent", () => {
    expect(deriveModelCatalogUrls([
      {
        endpointKey: "anthropic",
        protocol: "anthropic",
        baseUrl: "https://example.com/anthropic/"
      }
    ])).toEqual([
      "https://example.com/anthropic/v1/models",
      "https://example.com/v1/models",
      "https://example.com/models"
    ]);
  });

  it("uses an explicit catalog URL without appending a path", async () => {
    const request = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: {
        json: vi.fn().mockResolvedValue({
          data: [{ id: "model-a" }]
        })
      }
    });
    const service = new ProviderModelDiscoveryService(request);

    const result = await service.discoverProviderModels({
      providerKey: "relay",
      apiKey: "secret",
      modelCatalogUrl: "https://example.com/custom/catalog",
      endpoints: []
    });

    expect(request).toHaveBeenCalledWith(
      "https://example.com/custom/catalog",
      expect.objectContaining({ method: "GET" })
    );
    expect(result.catalogUrl).toBe("https://example.com/custom/catalog");
    expect(result.models.map((model) => model.providerModelId)).toEqual(["model-a"]);
  });

  it("continues only after 404 or 405 candidate responses", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 404,
        body: { json: vi.fn().mockResolvedValue({ error: "not found" }) }
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue({
            data: [{ id: "model-b" }]
          })
        }
      });
    const service = new ProviderModelDiscoveryService(request);

    const result = await service.discoverProviderModels({
      providerKey: "relay",
      apiKey: "secret",
      endpoints: [{
        endpointKey: "anthropic",
        protocol: "anthropic",
        baseUrl: "https://example.com/anthropic"
      }]
    });

    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/anthropic/v1/models",
      "https://example.com/v1/models"
    ]);
    expect(result.catalogUrl).toBe("https://example.com/v1/models");
  });
});
