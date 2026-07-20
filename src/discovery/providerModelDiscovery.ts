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

function buildAnthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  };
}

function parseBooleanFlag(value: unknown): boolean {
  return value === true;
}

function isLikelyNonToolModel(modelId: string): boolean {
  return /(?:^|[-_./:])(embedding|image|audio|tts|transcribe|whisper|moderation)(?:$|[-_./:])/i
    .test(modelId);
}

function inferSupportsTools(raw: Record<string, unknown>, modelId: string): boolean {
  if (typeof raw.supports_tools === "boolean") {
    return raw.supports_tools;
  }

  return !isLikelyNonToolModel(modelId);
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
        supportsTools: inferSupportsTools(raw, id),
        supportsJsonMode:
          parseBooleanFlag(raw.supports_json_mode) ||
          parseBooleanFlag(raw.supports_response_format_json_schema),
        rawMetadataJson: JSON.stringify(raw)
      });
    }

    return discoveredModels;
  }

  public async listAnthropicModels(input: {
    providerKey: string;
    baseUrl: string;
    apiKey: string;
  }): Promise<DiscoveredModel[]> {
    let response;

    try {
      response = await request(`${input.baseUrl}/models`, {
        method: "GET",
        headers: buildAnthropicHeaders(input.apiKey)
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

    return data.flatMap((item): DiscoveredModel[] => {
      if (typeof item !== "object" || item === null) {
        return [];
      }

      const raw = item as Record<string, unknown>;
      const id = typeof raw.id === "string" ? raw.id : null;
      if (!id) {
        return [];
      }

      return [{
        modelKey: `${input.providerKey}/${id}`,
        providerModelId: id,
        modelName: id,
        supportsStreaming: true,
        supportsTools: true,
        supportsJsonMode: false,
        rawMetadataJson: JSON.stringify(raw)
      }];
    });
  }
}
