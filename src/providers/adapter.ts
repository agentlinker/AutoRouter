import type { ModelDefinitionConfig } from "../config/schema.js";
import type { NormalizedChatRequest } from "../routing/types.js";
import type {
  AccountRuntimeState,
  EndpointRuntimeState,
  PlatformRuntimeState,
  ProviderRuntimeState
} from "../state/routerState.js";

export interface RouteTarget {
  platform: PlatformRuntimeState;
  provider: ProviderRuntimeState;
  endpoint: EndpointRuntimeState;
  account: AccountRuntimeState;
  modelId: string;
  model: ModelDefinitionConfig;
  credential?: string;
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
