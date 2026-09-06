import { request as undiciRequest } from "undici";
import type { WireProtocol } from "../config/schema.js";

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

function extractModelData(body: unknown): unknown[] {
  if (typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data)) {
    return body.data;
  }

  throw new HttpError(
    502,
    "provider_discovery_invalid_response",
    "Provider model discovery response must contain a data array",
    false
  );
}

export interface ModelCatalogEndpoint {
  endpointKey: string;
  protocol: WireProtocol;
  baseUrl: string;
  enabled?: boolean;
}

interface DiscoveryResponse {
  statusCode: number;
  body: {
    json(): Promise<unknown>;
  };
}

type DiscoveryRequest = (
  url: string,
  options: {
    method: "GET";
    headers: Record<string, string>;
  }
) => Promise<DiscoveryResponse>;

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function appendCatalogPath(baseUrl: string, path: string): string {
  return `${withoutTrailingSlash(baseUrl)}${path}`;
}

function rootWithoutAnthropicSuffix(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/(?:anthropic|claude)\/?$/i, "") || "/";
  url.search = "";
  url.hash = "";
  return withoutTrailingSlash(url.toString());
}

function candidatesForEndpoint(endpoint: ModelCatalogEndpoint): string[] {
  const baseUrl = withoutTrailingSlash(endpoint.baseUrl);
  const pathname = new URL(baseUrl).pathname.replace(/\/+$/, "");
  if (/\/v\d+(?:beta)?$/i.test(pathname)) {
    return [`${baseUrl}/models`];
  }
  if (endpoint.protocol !== "anthropic-messages") {
    return [
      appendCatalogPath(baseUrl, "/v1/models"),
      appendCatalogPath(baseUrl, "/models")
    ];
  }
  const rootUrl = rootWithoutAnthropicSuffix(baseUrl);
  return [
    appendCatalogPath(baseUrl, "/v1/models"),
    appendCatalogPath(rootUrl, "/v1/models"),
    appendCatalogPath(rootUrl, "/models")
  ];
}

export function deriveModelCatalogUrls(endpoints: ModelCatalogEndpoint[]): string[] {
  const enabled = endpoints.filter((endpoint) => endpoint.enabled !== false);
  const basis = enabled.find((endpoint) => endpoint.protocol === "openai-responses") ??
    enabled.find((endpoint) => endpoint.protocol === "openai-chat-completions") ??
    enabled.find((endpoint) => endpoint.protocol === "anthropic-messages");
  if (!basis) {
    return [];
  }
  return Array.from(new Set(candidatesForEndpoint(basis)));
}

function parseModels(providerKey: string, body: unknown): DiscoveredModel[] {
  const data = extractModelData(body);
  return data.flatMap((item): DiscoveredModel[] => {
    if (typeof item !== "object" || item === null) {
      return [];
    }
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id : null;
    if (!id) {
      return [];
    }
    const contextWindow =
      typeof raw.context_window === "number"
        ? raw.context_window
        : typeof raw.context_length === "number"
          ? raw.context_length
          : undefined;
    return [{
      modelKey: `${providerKey}/${id}`,
      providerModelId: id,
      modelName: id,
      contextWindow,
      supportsStreaming: raw.supports_streaming !== false,
      supportsTools: inferSupportsTools(raw, id),
      supportsJsonMode:
        parseBooleanFlag(raw.supports_json_mode) ||
        parseBooleanFlag(raw.supports_response_format_json_schema),
      rawMetadataJson: JSON.stringify(raw)
    }];
  });
}

export class ProviderModelDiscoveryService {
  public constructor(
    private readonly request: DiscoveryRequest =
      undiciRequest as unknown as DiscoveryRequest
  ) {}

  private async listModelsAtUrl(input: {
    providerKey: string;
    catalogUrl: string;
    apiKey: string;
  }): Promise<DiscoveredModel[]> {
    let response: DiscoveryResponse;
    try {
      response = await this.request(input.catalogUrl, {
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
    return parseModels(input.providerKey, body);
  }

  public async discoverProviderModels(input: {
    providerKey: string;
    apiKey: string;
    modelCatalogUrl?: string | null;
    endpoints: ModelCatalogEndpoint[];
  }): Promise<{ catalogUrl: string; models: DiscoveredModel[] }> {
    const explicitUrl = input.modelCatalogUrl?.trim();
    const candidates = explicitUrl
      ? [withoutTrailingSlash(explicitUrl)]
      : deriveModelCatalogUrls(input.endpoints);
    if (candidates.length === 0) {
      throw new HttpError(
        422,
        "provider_catalog_unavailable",
        "Provider has no model catalog URL or enabled endpoint to derive one from",
        false
      );
    }
    let lastError: unknown;
    for (const catalogUrl of candidates) {
      try {
        return {
          catalogUrl,
          models: await this.listModelsAtUrl({
            providerKey: input.providerKey,
            catalogUrl,
            apiKey: input.apiKey
          })
        };
      } catch (error) {
        lastError = error;
        if (
          error instanceof HttpError &&
          (error.statusCode === 404 || error.statusCode === 405) &&
          !explicitUrl
        ) {
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new HttpError(
      404,
      "provider_discovery_failed",
      "Provider model discovery failed for all derived catalog URLs",
      false
    );
  }

}
