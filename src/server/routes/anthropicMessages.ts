import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";

import {
  executeRoutedRequest,
  streamRoutedRequest,
  type RoutedCandidate
} from "../../routing/executeRoutedRequest.js";
import { normalizeChatRequest } from "../../routing/normalizeRequest.js";
import { selectRoute } from "../../routing/routeEngine.js";
import { StreamUsageTap } from "../../routing/streamUsageTap.js";
import { sha256 } from "../../utils/hash.js";
import { HttpError } from "../../utils/httpErrors.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import type { RuntimeStatusService } from "../../runtime/runtimeStatusService.js";
import type { TraceAttempt, TraceCandidate } from "../../trace/traceTypes.js";
import { recordRouteSelectionFailure } from "./routeSelectionFailure.js";
import type {
  ChatCompletionsRequestBody,
  ChatMessage,
  ToolDefinition
} from "../../routing/types.js";

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicMessagesRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }>;
  tool_choice?: {
    type?: string;
    name?: string;
  };
  metadata?: Record<string, unknown>;
}

interface OpenAiChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: Array<{
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text ?? "");
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }

  return content === undefined || content === null ? "" : JSON.stringify(content);
}

function systemToMessage(system: AnthropicMessagesRequestBody["system"]): ChatMessage | null {
  if (system === undefined) {
    return null;
  }

  return {
    role: "system",
    content: contentToText(system)
  };
}

function toChatMessages(messages: AnthropicMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }

    const textBlocks = message.content.filter((block) => block.type === "text");
    const toolUseBlocks = message.content.filter((block) => block.type === "tool_use");
    const toolResultBlocks = message.content.filter((block) => block.type === "tool_result");

    if (message.role === "assistant" && toolUseBlocks.length > 0) {
      result.push({
        role: "assistant",
        content: textBlocks.map((block) => block.text ?? "").join("\n"),
        tool_calls: toolUseBlocks.map((block) => ({
          id: block.id ?? "tool_call",
          type: "function",
          function: {
            name: block.name ?? "tool",
            arguments: JSON.stringify(block.input ?? {})
          }
        }))
      });
    } else if (textBlocks.length > 0) {
      result.push({
        role: message.role,
        content: textBlocks.map((block) => block.text ?? "").join("\n")
      });
    }

    for (const block of toolResultBlocks) {
      result.push({
        role: "tool",
        tool_call_id: block.tool_use_id ?? "tool_call",
        content: contentToText(block.content)
      });
    }

    if (textBlocks.length === 0 && toolUseBlocks.length === 0 && toolResultBlocks.length === 0) {
      result.push({
        role: message.role,
        content: contentToText(message.content)
      });
    }
  }

  return result;
}

function toChatTools(tools: AnthropicMessagesRequestBody["tools"]): ToolDefinition[] | undefined {
  return tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema ?? {}
    }
  }));
}

function toChatToolChoice(toolChoice: AnthropicMessagesRequestBody["tool_choice"]): unknown {
  if (!toolChoice?.type || toolChoice.type === "auto") {
    return toolChoice?.type;
  }
  if (toolChoice.type === "any") {
    return "required";
  }
  if (toolChoice.type === "tool" && toolChoice.name) {
    return {
      type: "function",
      function: {
        name: toolChoice.name
      }
    };
  }
  return undefined;
}

function toChatRequest(body: AnthropicMessagesRequestBody): ChatCompletionsRequestBody {
  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpError(400, "invalid_request", "model and messages are required");
  }

  const systemMessage = systemToMessage(body.system);

  return {
    model: body.model,
    messages: [
      ...(systemMessage ? [systemMessage] : []),
      ...toChatMessages(body.messages)
    ],
    stream: false,
    tools: toChatTools(body.tools),
    tool_choice: toChatToolChoice(body.tool_choice),
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    metadata: body.metadata
  };
}

function parseToolArguments(value: string | undefined): unknown {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function toAnthropicResponse(body: OpenAiChatResponse, requestedModel: string) {
  const choice = body.choices?.[0];
  const message = choice?.message;
  const content: Array<Record<string, unknown>> = [];
  const text = contentToText(message?.content);

  if (text.length > 0) {
    content.push({ type: "text", text });
  }

  for (const toolCall of message?.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: toolCall.id ?? "tool_call",
      name: toolCall.function?.name ?? "tool",
      input: parseToolArguments(toolCall.function?.arguments)
    });
  }

  const stopReason =
    (message?.tool_calls?.length ?? 0) > 0
      ? "tool_use"
      : choice?.finish_reason === "length"
        ? "max_tokens"
        : "end_turn";

  return {
    id: body.id ?? "msg_autorouter",
    type: "message",
    role: "assistant",
    model: body.model ?? requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0
    }
  };
}

function writeSse(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeAnthropicStream(reply: FastifyReply, response: ReturnType<typeof toAnthropicResponse>) {
  reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("cache-control", "no-cache");
  reply.raw.setHeader("connection", "keep-alive");

  writeSse(reply, "message_start", {
    type: "message_start",
    message: {
      ...response,
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: 0
      }
    }
  });

  response.content.forEach((block, index) => {
    writeSse(reply, "content_block_start", {
      type: "content_block_start",
      index,
      content_block:
        block.type === "tool_use"
          ? { ...block, input: {} }
          : { type: "text", text: "" }
    });

    if (block.type === "tool_use") {
      writeSse(reply, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input ?? {})
        }
      });
    } else {
      writeSse(reply, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "text_delta",
          text: block.text ?? ""
        }
      });
    }

    writeSse(reply, "content_block_stop", {
      type: "content_block_stop",
      index
    });
  });

  writeSse(reply, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: response.stop_reason,
      stop_sequence: null
    },
    usage: {
      output_tokens: response.usage.output_tokens
    }
  });
  writeSse(reply, "message_stop", { type: "message_stop" });
  reply.raw.end();
}

export async function registerAnthropicMessagesRoute(
  fastify: FastifyInstance,
  runtimeManager: RuntimeManagerLike,
  runtimeStatusService?: RuntimeStatusService
) {
  fastify.post<{ Body: AnthropicMessagesRequestBody }>("/v1/messages", async (request, reply) => {
    const state = runtimeManager.getSnapshot();
    // Anthropic 请求先转成内部 Chat Completions 形状，再走与 /v1/chat/completions
    // 相同的路由与执行链路（不再通过 fastify.inject 复用内部 HTTP 路由）。
    const normalizedRequest = normalizeChatRequest(toChatRequest(request.body));
    const sessionId =
      typeof request.headers["x-autorouter-session-id"] === "string"
        ? request.headers["x-autorouter-session-id"]
        : null;
    const privacyLevel =
      typeof normalizedRequest.metadata.privacy_level === "string"
        ? normalizedRequest.metadata.privacy_level
        : state.config.defaults.privacy_level;

    const traceId = randomUUID();
    const startedAt = Date.now();
    const promptHash = sha256(JSON.stringify(normalizedRequest.messages));
    const hasTools = normalizedRequest.tools.length > 0;
    // 客户端要的是流式，但当前实现先取完整响应再转 Anthropic SSE
    const clientWantsStream = request.body.stream === true;
    // 实际执行时是否走了原生 Anthropic 直通（零转换）
    let nativePassthrough = false;

    let routeDecision;
    try {
      routeDecision = selectRoute(
        state.config,
        state.modelCatalog,
        state.priceTable,
        state.platforms,
        state.providers,
        state.endpoints,
        state.accounts,
        normalizedRequest.model,
        hasTools,
        normalizedRequest.response_format !== undefined,
        normalizedRequest.context_tokens_est,
        privacyLevel,
        sessionId ? state.stickySessions.get(sessionId) : null,
        state.modelStatuses ?? {},
        // 优先选 anthropic 协议的 endpoint，命中即可零转换直通
        "anthropic"
      );
    } catch (error) {
      recordRouteSelectionFailure(runtimeManager, error, {
        model: normalizedRequest.model,
        promptHash,
        stream: clientWantsStream,
        hasTools,
        privacyLevel,
        contextTokensEst: normalizedRequest.context_tokens_est,
        sessionId,
        policyHits: ["anthropic_inbound", "route_selection_failed"]
      });
      throw error;
    }

    const nativeMessagesRequest = () => ({
      ...(request.body as unknown as Record<string, unknown>),
      model: request.body.model
    });

    /** trace 的公共部分，直通流式与非流式两条路共用 */
    const buildTraceBase = (
      selected: RoutedCandidate | null,
      attempts: TraceAttempt[],
      fallbacks: TraceCandidate[]
    ) => ({
      trace_id: traceId,
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      request: {
        model: request.body.model,
        normalized_model: routeDecision.normalizedModel,
        prompt_hash: promptHash,
        // trace 记客户端真实意图，而不是内部转换后的 stream=false
        stream: clientWantsStream,
        has_tools: hasTools,
        privacy_level: privacyLevel,
        context_tokens_est: normalizedRequest.context_tokens_est,
        requested_context_window: routeDecision.requestedContextWindow ?? null
      },
      candidates: routeDecision.candidates.map((candidate) => ({
        route_id: candidate.routeId,
        endpoint: candidate.endpoint,
        platform: candidate.platform,
        provider: candidate.provider,
        account: candidate.account,
        model_id: candidate.modelId,
        model: candidate.model,
        score: candidate.score,
        sticky: candidate.sticky
      })),
      filtered: routeDecision.filtered.map((candidate) => ({
        route_id: candidate.routeId,
        endpoint: candidate.endpoint,
        platform: candidate.platform,
        provider: candidate.provider,
        account: candidate.account,
        model_id: candidate.modelId,
        model: candidate.model,
        reason: candidate.filteredReason,
        score: candidate.score,
        sticky: candidate.sticky
      })),
      selected: selected
        ? {
            route_id: selected.routeId,
            endpoint: selected.endpoint.id,
            platform: selected.platform.id,
            provider: selected.provider.id,
            account_hash: sha256(selected.account.id),
            model_id: selected.modelId,
            model: selected.model,
            score: selected.score
          }
        : null,
      attempts,
      fallbacks,
      feedback: null
    });

    // 客户端要流式且存在原生 anthropic 候选时，直接把上游 SSE 字节透传，
    // 拿回真实 TTFT（不再等完整响应后再合成 SSE）。
    const hasNativeStreamCandidate = routeDecision.ordered.some((candidate) =>
      Boolean(state.adapters.forProtocol(candidate.platform.protocol).streamMessage)
    );

    if (clientWantsStream && hasNativeStreamCandidate) {
      const streamOutcome = {
        selected: null as RoutedCandidate | null,
        attempts: [] as TraceAttempt[],
        fallbacks: [] as TraceCandidate[],
        lastError: undefined as unknown,
        sawSupportedCandidate: false,
        partialFailure: false
      };

      const stream = streamRoutedRequest(
        {
          state,
          runtimeStatusService,
          candidates: routeDecision.ordered,
          requestHeaders: request.headers,
          supportsCandidate: (_candidate, target) =>
            Boolean(state.adapters.forProtocol(target.platform.protocol).streamMessage),
          invokeStream: (_candidate, target) =>
            state.adapters
              .forProtocol(target.platform.protocol)
              .streamMessage!(nativeMessagesRequest(), target),
          onStreamStart: () => {
            if (!reply.raw.headersSent) {
              reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
              reply.raw.setHeader("cache-control", "no-cache");
              reply.raw.setHeader("connection", "keep-alive");
              reply.raw.setHeader("x-autorouter-trace-id", traceId);
              reply.raw.setHeader("x-autorouter-normalized-model", routeDecision.normalizedModel);
            }
          }
        },
        streamOutcome
      );

      // 先透传字节，再旁路观测 usage
      const usageTap = new StreamUsageTap();
      for await (const event of stream) {
        reply.raw.write(event.chunk.raw);
        usageTap.observe(event.chunk.raw);
      }
      usageTap.finish();

      const streamUsage = usageTap.result();
      const streamPriceEstimate = streamOutcome.selected
        ? state.priceTable.estimateCost(
            streamOutcome.selected.modelId,
            streamUsage?.prompt_tokens,
            streamUsage?.completion_tokens
          )
        : null;

      state.traceStore.append({
        ...buildTraceBase(streamOutcome.selected, streamOutcome.attempts, streamOutcome.fallbacks),
        policy_hits: [
          "anthropic_inbound",
          "anthropic_native",
          "anthropic_native_stream",
          ...(routeDecision.sawProtocolMatch ? [] : ["protocol_mismatch"]),
          ...(sessionId ? ["session_sticky"] : []),
          ...(streamOutcome.fallbacks.length > 0 ? ["fallback_chain"] : []),
          ...(streamOutcome.partialFailure ? ["stream_partial_failed"] : []),
          ...(routeDecision.contextWindowUnknown ? ["context_window_unknown"] : [])
        ],
        execution:
          streamOutcome.selected && !streamOutcome.partialFailure
            ? {
                status: streamOutcome.fallbacks.length > 0 ? "success_with_fallback" : "success",
                latency_ms: Date.now() - startedAt,
                input_tokens: streamUsage?.prompt_tokens,
                output_tokens: streamUsage?.completion_tokens,
                total_tokens: streamUsage?.total_tokens
              }
            : {
                status: "failed",
                latency_ms: Date.now() - startedAt,
                error:
                  streamOutcome.lastError instanceof Error
                    ? streamOutcome.lastError.message
                    : "provider_request_failed"
              },
        cost: {
          estimated_usd: streamPriceEstimate?.estimatedUsd ?? null,
          actual_usd: null,
          price_confidence: streamPriceEstimate?.confidence ?? "unknown"
        }
      });

      if (!streamOutcome.selected) {
        throw streamOutcome.lastError instanceof Error
          ? streamOutcome.lastError
          : new HttpError(503, "all_candidates_failed", "All candidates failed", true);
      }

      if (sessionId) {
        state.stickySessions.set(sessionId, {
          routeId: streamOutcome.selected.routeId,
          platformId: streamOutcome.selected.platform.id,
          providerId: streamOutcome.selected.provider.id,
          endpointId: streamOutcome.selected.endpoint.id,
          accountId: streamOutcome.selected.account.id,
          modelId: streamOutcome.selected.modelId
        });
      }

      reply.raw.end();
      return reply;
    }

    const outcome = await executeRoutedRequest({
      state,
      runtimeStatusService,
      candidates: routeDecision.ordered,
      requestHeaders: request.headers,
      // adapter 支持原生 Messages 时零转换直通，否则退化为 Chat Completions 转换。
      // 直通路径保住 thinking blocks / cache_control / tool_use 等字段。
      invoke: (_candidate, target) => {
        const adapter = state.adapters.forProtocol(target.platform.protocol);
        if (adapter.messageCompletion) {
          nativePassthrough = true;
          return adapter.messageCompletion(nativeMessagesRequest(), target);
        }

        return adapter.chatCompletion(normalizedRequest, target);
      }
    });

    const baseTrace = buildTraceBase(outcome.selected, outcome.attempts, outcome.fallbacks);

    // nativePassthrough 在 invoke 里才确定，所以延迟到落 trace 时再取
    const policyHits = [
      "anthropic_inbound",
      // 观测实际走了直通还是转换；protocol_mismatch 表示没有同协议候选可选
      ...(nativePassthrough ? ["anthropic_native"] : []),
      ...(routeDecision.sawProtocolMatch ? [] : ["protocol_mismatch"]),
      ...(sessionId ? ["session_sticky"] : []),
      ...(outcome.fallbacks.length > 0 ? ["fallback_chain"] : []),
      ...(routeDecision.contextWindowUnknown ? ["context_window_unknown"] : [])
    ];

    if (!outcome.response || !outcome.selected) {
      state.traceStore.append({
        ...baseTrace,
        policy_hits: policyHits,
        execution: {
          status: "failed",
          latency_ms: Date.now() - startedAt,
          error:
            outcome.lastError instanceof Error
              ? outcome.lastError.message
              : "provider_request_failed"
        },
        cost: {
          estimated_usd: null,
          actual_usd: null,
          price_confidence: "unknown"
        }
      });

      throw outcome.lastError instanceof Error
        ? outcome.lastError
        : new HttpError(503, "all_candidates_failed", "All candidates failed", true);
    }

    const priceEstimate = state.priceTable.estimateCost(
      outcome.selected.modelId,
      outcome.response.usage?.prompt_tokens,
      outcome.response.usage?.completion_tokens
    );

    if (sessionId) {
      state.stickySessions.set(sessionId, {
        routeId: outcome.selected.routeId,
        platformId: outcome.selected.platform.id,
        providerId: outcome.selected.provider.id,
        endpointId: outcome.selected.endpoint.id,
        accountId: outcome.selected.account.id,
        modelId: outcome.selected.modelId
      });
    }

    state.traceStore.append({
      ...baseTrace,
      policy_hits: policyHits,
      execution: {
        status: outcome.fallbacks.length > 0 ? "success_with_fallback" : "success",
        latency_ms: Date.now() - startedAt,
        input_tokens: outcome.response.usage?.prompt_tokens,
        output_tokens: outcome.response.usage?.completion_tokens,
        total_tokens: outcome.response.usage?.total_tokens
      },
      cost: {
        estimated_usd: priceEstimate.estimatedUsd,
        actual_usd: null,
        price_confidence: priceEstimate.confidence
      }
    });

    reply.header("x-autorouter-trace-id", traceId);
    reply.header("x-autorouter-normalized-model", routeDecision.normalizedModel);

    // 直通路径：上游本就是 Anthropic 响应，非流式时按字节原样返回
    if (nativePassthrough && !clientWantsStream && outcome.response.raw !== undefined) {
      return reply.type("application/json").send(outcome.response.raw);
    }

    const response = nativePassthrough
      ? (outcome.response.body as ReturnType<typeof toAnthropicResponse>)
      : toAnthropicResponse(outcome.response.body as OpenAiChatResponse, request.body.model);

    if (clientWantsStream) {
      writeAnthropicStream(reply, response);
      return reply;
    }

    return response;
  });
}
