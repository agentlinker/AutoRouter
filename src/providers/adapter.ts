import type { EndpointConfig } from "../config/schema.js";
import type { NormalizedChatRequest } from "../routing/types.js";

export interface RouteTarget {
  endpointId: string;
  platformId: string;
  accountId: string;
  model: string;
  endpointConfig: EndpointConfig;
  apiKey?: string;
}

export interface HealthResult {
  status: "healthy" | "degraded" | "down";
  detail?: string;
}

export interface ProviderResponse {
  status: number;
  body: unknown;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ProviderStreamChunk {
  raw: string;
}

export interface ProviderAdapter {
  readonly type: string;
  healthCheck(target: RouteTarget): Promise<HealthResult>;
  chatCompletion(
    request: NormalizedChatRequest,
    target: RouteTarget
  ): Promise<ProviderResponse>;
  streamChatCompletion?(
    request: NormalizedChatRequest,
    target: RouteTarget
  ): AsyncIterable<ProviderStreamChunk>;
}
