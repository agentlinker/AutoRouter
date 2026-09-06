import type { ModelDefinitionConfig } from "../config/schema.js";
import type { NormalizedChatRequest } from "../routing/types.js";
import type {
  AccountRuntimeState,
  EndpointRuntimeState,
  PlatformRuntimeState,
  ProviderRuntimeState
} from "../state/routerState.js";

type RequestHeaderValue = string | string[] | undefined;

export interface RouteTarget {
  platform: PlatformRuntimeState;
  provider: ProviderRuntimeState;
  endpoint: EndpointRuntimeState;
  account: AccountRuntimeState;
  modelId: string;
  model: ModelDefinitionConfig;
  credential?: string;
  request_headers?: Record<string, RequestHeaderValue>;
}

export interface ProviderResponse {
  status: number;
  body: unknown;
  /**
   * 上游响应的原始 JSON 文本。存在时应字节级透传给调用方，避免
   * JSON → 对象 → JSON 往返导致的数字精度、键序、重复键丢失。
   * `body` 仅用于只读记账，不参与回写。
   */
  raw?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ProviderStreamChunk {
  raw: string;
}

export type ProviderResponsesRequest = Record<string, unknown> & {
  model: string;
  stream?: boolean;
};

/** Anthropic Messages 请求体，原样转发给上游 `/messages` */
export type ProviderMessagesRequest = Record<string, unknown> & {
  model: string;
  stream?: boolean;
};

export interface ChatCompletionsAdapter {
  readonly protocol: "openai-chat-completions";
  chatCompletion(
    request: NormalizedChatRequest,
    target: RouteTarget
  ): Promise<ProviderResponse>;
  streamChatCompletion(
    request: NormalizedChatRequest,
    target: RouteTarget
  ): AsyncIterable<ProviderStreamChunk>;
}

export interface ResponsesAdapter {
  readonly protocol: "openai-responses";
  responseCompletion(
    request: ProviderResponsesRequest,
    target: RouteTarget
  ): Promise<ProviderResponse>;
  streamResponse(
    request: ProviderResponsesRequest,
    target: RouteTarget
  ): AsyncIterable<ProviderStreamChunk>;
}

export interface MessagesAdapter {
  readonly protocol: "anthropic-messages";
  messageCompletion(
    request: ProviderMessagesRequest,
    target: RouteTarget
  ): Promise<ProviderResponse>;
  streamMessage(
    request: ProviderMessagesRequest,
    target: RouteTarget
  ): AsyncIterable<ProviderStreamChunk>;
}

export interface ProtocolAdapters {
  "openai-responses": ResponsesAdapter;
  "openai-chat-completions": ChatCompletionsAdapter;
  "anthropic-messages": MessagesAdapter;
}

export type ProviderAdapter = ProtocolAdapters[keyof ProtocolAdapters];
