import { request } from "undici";

import { HttpError } from "../utils/httpErrors.js";

export interface DiscoveredModel {
  modelKey: string;
  providerModelId: string;
  modelName: string;
  contextWindow?: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsJsonMode: boolean;
  pricingJson?: string;
  rawMetadataJson?: string;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`
  };
}

function parseBooleanFlag(value: unknown): boolean {
  return value === true;
}

export class ProviderModelDiscoveryService {
  public async listOpenAiCompatibleModels(input: {
    providerKey: string;
    baseUrl: string;
    apiKey: string;
  }): Promise<DiscoveredModel[]> {
    let response;

    try {
      response = await request(`${input.baseUrl}/models`, {
        method: "GET",
        headers: buildHeaders(input.apiKey)
      });
    } catch (error) {
      throw new HttpError(
        503,
        "provider_unreachable",
        error instanceof Error ? error.message : "provider unreachable",
        true
      );
    }

    const body = await response.body.json();

    if (response.statusCode >= 400) {
      throw new HttpError(
        response.statusCode,
        "provider_discovery_failed",
        `Provider model discovery failed with status ${response.statusCode}`,
        response.statusCode >= 500 || response.statusCode === 429
      );
    }

    const data = typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data)
      ? body.data
      : [];

    const discoveredModels: DiscoveredModel[] = [];

    for (const item of data) {
      if (typeof item !== "object" || item === null) {
        continue;
      }

      const raw = item as Record<string, unknown>;
      const id = typeof raw.id === "string" ? raw.id : null;
      if (!id) {
        continue;
      }

      const contextWindow =
        typeof raw.context_window === "number"
          ? raw.context_window
          : typeof raw.context_length === "number"
            ? raw.context_length
            : undefined;

      discoveredModels.push({
        modelKey: `${input.providerKey}/${id}`,
        providerModelId: id,
        modelName: id,
        contextWindow,
        supportsStreaming: raw.supports_streaming !== false,
        supportsTools: parseBooleanFlag(raw.supports_tools),
        supportsJsonMode:
          parseBooleanFlag(raw.supports_json_mode) ||
          parseBooleanFlag(raw.supports_response_format_json_schema),
        rawMetadataJson: JSON.stringify(raw)
      });
    }

    return discoveredModels;
  }
}
