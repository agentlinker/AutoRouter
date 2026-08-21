import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";

import { selectRoute } from "../../routing/routeEngine.js";
import {
  executeRoutedRequest,
  streamRoutedRequest,
  type RoutedCandidate
} from "../../routing/executeRoutedRequest.js";
import { normalizeChatRequest } from "../../routing/normalizeRequest.js";
import { StreamUsageTap } from "../../routing/streamUsageTap.js";
import type { ProviderResponse, RouteTarget } from "../../providers/adapter.js";
import type { TraceAttempt, TraceCandidate } from "../../trace/traceTypes.js";
import { estimateResponsesContextTokens as estimateResponsesContextTokensUtil } from "../../utils/contextTokens.js";
import { recordRouteSelectionFailure } from "./routeSelectionFailure.js";
import { sha256 } from "../../utils/hash.js";
import type { ChatCompletionsRequestBody, ChatMessage, ToolDefinition } from "../../routing/types.js";
import { HttpError } from "../../utils/httpErrors.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import type { RuntimeStatusService } from "../../runtime/runtimeStatusService.js";
import { isResponsesUnsupportedError } from "../../utils/responsesFallback.js";

interface ResponsesRequestBody {
  model?: string;
  input?: unknown;
  instructions?: string;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_output_tokens?: number;
  metadata?: Record<string, unknown>;
  upstream_metadata?: Record<string, unknown>;
}

interface ChatCompletionResponseBody {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: unknown;
      tool_calls?: Array<{
        id?: string;
        type?: string;
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
    total_tokens?: number;
  };
}

type ResponsesOutputItem =
  | {
      id: string;
      type: "message";
      status: "completed";
      role: "assistant";
      content: Array<{
        type: "output_text";
        text: string;
        annotations: unknown[];
      }>;
    }
  | {
      id: string;
      type: "function_call";
      status: "completed";
      call_id: string;
      name: string;
      arguments: string;
    };

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          const text = record.text ?? record.input_text ?? record.output_text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    const text = record.text ?? record.input_text ?? record.output_text;
    if (typeof text === "string") {
      return text;
    }
  }

  return content == null ? "" : JSON.stringify(content);
}

function responsesInputToMessages(input: unknown, instructions?: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  if (!Array.isArray(input)) {
    throw new HttpError(400, "invalid_request", "input is required");
  }

  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const role = typeof record.role === "string" ? record.role : undefined;

    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        content: contentToText(record.output),
        tool_call_id: typeof record.call_id === "string" ? record.call_id : undefined
      });
      continue;
    }

    if (type === "function_call") {
      const callId = typeof record.call_id === "string"
        ? record.call_id
        : typeof record.id === "string"
          ? record.id
          : undefined;
      const name = typeof record.name === "string" ? record.name : undefined;
      if (!callId || !name) {
        continue;
      }

      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: {
              name,
              arguments: typeof record.arguments === "string" ? record.arguments : "{}"
            }
          }
        ]
      });
      continue;
    }

    if (type === "message" || role) {
      const messageRole =
        role === "assistant" || role === "system" || role === "tool" ? role : "user";
      messages.push({
        role: messageRole,
        content: contentToText(record.content)
      } as ChatMessage);
    }
  }

  if (messages.length === 0 || messages.every((message) => message.role === "system")) {
    throw new HttpError(400, "invalid_request", "input must contain at least one message");
  }

  return messages;
}

function responsesToolsToChatTools(tools: unknown[] | undefined): ToolDefinition[] {
  if (!tools) {
    return [];
  }

  return tools
    .map((tool): ToolDefinition | null => {
      if (!tool || typeof tool !== "object") {
        return null;
      }

      const record = tool as Record<string, unknown>;
      if (record.type !== "function" || typeof record.name !== "string") {
        return null;
      }

      return {
        type: "function",
        function: {
          name: record.name,
          description: typeof record.description === "string" ? record.description : undefined,
          parameters:
            record.parameters && typeof record.parameters === "object"
              ? (record.parameters as Record<string, unknown>)
              : undefined
        }
      };
    })
    .filter((tool): tool is ToolDefinition => tool !== null);
}

function chatToResponsesBody(chatBody: ChatCompletionResponseBody, requestedModel: string) {
  const responseId = `resp_${randomUUID()}`;
  const message = chatBody.choices?.[0]?.message;
  const output: ResponsesOutputItem[] = [];
  const text = contentToText(message?.content);

  if (text) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text,
          annotations: []
        }
      ]
    });
  }

  for (const toolCall of message?.tool_calls ?? []) {
    if (toolCall.function?.name) {
      output.push({
        id: toolCall.id ?? `fc_${randomUUID()}`,
        type: "function_call",
        status: "completed",
        call_id: toolCall.id ?? `call_${randomUUID()}`,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments ?? "{}"
      });
    }
  }

  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: chatBody.model ?? requestedModel,
    output,
    output_text: text,
    usage: chatBody.usage
      ? {
          input_tokens: chatBody.usage.prompt_tokens,
          output_tokens: chatBody.usage.completion_tokens,
          total_tokens: chatBody.usage.total_tokens
        }
      : undefined
  };
}

function writeSse(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function wrapResponseEvent(
  type: "response.created" | "response.in_progress" | "response.completed",
  response: ReturnType<typeof chatToResponsesBody>,
  sequenceNumber: number
) {
  return {
    type,
    response,
    sequence_number: sequenceNumber
  };
}

function estimateResponsesContextTokens(body: ResponsesRequestBody): number {
  return estimateResponsesContextTokensUtil({
    input: body.input,
    instructions: body.instructions,
    tools: body.tools,
    metadata: body.metadata
  });
}

function responsesUsageToChatUsage(usage: unknown): {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
} | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;
  const promptTokens = record.prompt_tokens ?? record.input_tokens;
  const completionTokens = record.completion_tokens ?? record.output_tokens;
  const totalTokens = record.total_tokens;

  return {
    prompt_tokens: typeof promptTokens === "number" ? promptTokens : undefined,
    completion_tokens: typeof completionTokens === "number" ? completionTokens : undefined,
    total_tokens: typeof totalTokens === "number" ? totalTokens : undefined
  };
}

/**
 * 所有候选都没有原生 responses 支持时的降级路径：转成 Chat Completions 执行，
 * 再把结果转回 Responses 形状。直接走共享执行层，不再 inject 内部 HTTP 路由。
 */
async function fallbackResponsesViaChat(
  runtimeManager: RuntimeManagerLike,
  runtimeStatusService: RuntimeStatusService | undefined,
  request: { body: ResponsesRequestBody; headers?: RouteTarget["request_headers"] },
  reply: FastifyReply
) {
  const state = runtimeManager.getSnapshot();
  const normalizedRequest = normalizeChatRequest({
    model: request.body.model!,
    messages: responsesInputToMessages(request.body.input, request.body.instructions),
    stream: false,
    tools: responsesToolsToChatTools(request.body.tools),
    tool_choice: request.body.tool_choice,
    temperature: request.body.temperature,
    max_tokens: request.body.max_output_tokens,
    metadata: request.body.metadata,
    upstream_metadata: request.body.upstream_metadata
  });

  const privacyLevel =
    typeof normalizedRequest.metadata.privacy_level === "string"
      ? normalizedRequest.metadata.privacy_level
      : state.config.defaults.privacy_level;
  const traceId = randomUUID();
  const startedAt = Date.now();
  const promptHash = sha256(JSON.stringify(normalizedRequest.messages));

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
      normalizedRequest.tools.length > 0,
      normalizedRequest.response_format !== undefined,
      normalizedRequest.context_tokens_est,
      privacyLevel,
      null,
      state.modelStatuses ?? {},
      // 已降级成 Chat Completions 形态，优先选 openai 协议的 endpoint（零转换透传）
      "openai"
    );
  } catch (error) {
    recordRouteSelectionFailure(runtimeManager, error, {
      model: normalizedRequest.model,
      promptHash,
      stream: request.body.stream ?? false,
      hasTools: normalizedRequest.tools.length > 0,
      privacyLevel,
      contextTokensEst: normalizedRequest.context_tokens_est,
      sessionId: null,
      policyHits: ["responses_via_chat", "route_selection_failed"]
    });
    throw error;
  }

  const outcome = await executeRoutedRequest({
    state,
    runtimeStatusService,
    candidates: routeDecision.ordered,
    requestHeaders: request.headers,
    invoke: (_candidate, target) =>
      state.adapters.forProtocol(target.platform.protocol).chatCompletion(normalizedRequest, target)
  });

  const priceEstimate = outcome.selected
    ? state.priceTable.estimateCost(
        outcome.selected.modelId,
        outcome.response?.usage?.prompt_tokens,
        outcome.response?.usage?.completion_tokens
      )
    : null;

  state.traceStore.append({
    trace_id: traceId,
    timestamp: new Date().toISOString(),
    session_id: null,
    request: {
      model: request.body.model!,
      normalized_model: routeDecision.normalizedModel,
      prompt_hash: promptHash,
      stream: request.body.stream ?? false,
      has_tools: normalizedRequest.tools.length > 0,
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
    selected: outcome.selected
      ? {
          route_id: outcome.selected.routeId,
          endpoint: outcome.selected.endpoint.id,
          platform: outcome.selected.platform.id,
          provider: outcome.selected.provider.id,
          account_hash: sha256(outcome.selected.account.id),
          model_id: outcome.selected.modelId,
          model: outcome.selected.model,
          score: outcome.selected.score
        }
      : null,
    policy_hits: [
      "responses_via_chat",
      ...(outcome.fallbacks.length > 0 ? ["fallback_chain"] : []),
      ...(routeDecision.contextWindowUnknown ? ["context_window_unknown"] : [])
    ],
    execution: outcome.response
      ? {
          status: outcome.fallbacks.length > 0 ? "success_with_fallback" : "success",
          latency_ms: Date.now() - startedAt,
          input_tokens: outcome.response.usage?.prompt_tokens,
          output_tokens: outcome.response.usage?.completion_tokens,
          total_tokens: outcome.response.usage?.total_tokens
        }
      : {
          status: "failed",
          latency_ms: Date.now() - startedAt,
          error:
            outcome.lastError instanceof Error
              ? outcome.lastError.message
              : "provider_request_failed"
        },
    cost: {
      estimated_usd: priceEstimate?.estimatedUsd ?? null,
      actual_usd: null,
      price_confidence: priceEstimate?.confidence ?? "unknown"
    },
    attempts: outcome.attempts,
    fallbacks: outcome.fallbacks,
    feedback: null
  });

  if (!outcome.response) {
    throw outcome.lastError instanceof Error
      ? outcome.lastError
      : new HttpError(503, "all_candidates_failed", "All candidates failed", true);
  }

  reply.header("x-autorouter-trace-id", traceId);
  reply.header("x-autorouter-normalized-model", routeDecision.normalizedModel);

  const responseBody = chatToResponsesBody(
    outcome.response.body as ChatCompletionResponseBody,
    request.body.model!
  );

  if (request.body.stream) {
    reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("connection", "keep-alive");

    let sequenceNumber = 1;
    const inProgressResponse = { ...responseBody, status: "in_progress", output: [] };
    writeSse(
      reply,
      "response.created",
      wrapResponseEvent("response.created", inProgressResponse, sequenceNumber++)
    );
    writeSse(
      reply,
      "response.in_progress",
      wrapResponseEvent("response.in_progress", inProgressResponse, sequenceNumber++)
    );
    for (const item of responseBody.output) {
      writeSse(reply, "response.output_item.added", {
        type: "response.output_item.added",
        item,
        output_index: 0,
        sequence_number: sequenceNumber++
      });
      if (item.type === "message") {
        const content = item.content[0];
        const contentText = content?.text ?? "";
        writeSse(reply, "response.content_part.added", {
          type: "response.content_part.added",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
          sequence_number: sequenceNumber++
        });
        writeSse(reply, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: contentText,
          sequence_number: sequenceNumber++
        });
        writeSse(reply, "response.output_text.done", {
          type: "response.output_text.done",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: contentText,
          sequence_number: sequenceNumber++
        });
        writeSse(reply, "response.content_part.done", {
          type: "response.content_part.done",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: content ?? { type: "output_text", text: "", annotations: [] },
          sequence_number: sequenceNumber++
        });
      }
      writeSse(reply, "response.output_item.done", {
        type: "response.output_item.done",
        item,
        output_index: 0,
        sequence_number: sequenceNumber++
      });
    }
    writeSse(
      reply,
      "response.completed",
      wrapResponseEvent("response.completed", { ...responseBody, status: "completed" }, sequenceNumber++)
    );
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    return reply;
  }

  return responseBody;
}

export async function registerResponsesRoute(
  fastify: FastifyInstance,
  runtimeManager: RuntimeManagerLike,
  runtimeStatusService?: RuntimeStatusService
) {
  fastify.post<{ Body: ResponsesRequestBody }>("/v1/responses", async (request, reply) => {
    if (!request.body.model) {
      throw new HttpError(400, "invalid_request", "model is required");
    }

    const state = runtimeManager.getSnapshot();
    const privacyLevel =
      typeof request.body.metadata?.privacy_level === "string"
        ? request.body.metadata.privacy_level
        : state.config.defaults.privacy_level;
    const traceId = randomUUID();
    const startedAt = Date.now();
    const promptHash = sha256(JSON.stringify(request.body.input ?? null));
    const hasTools = Array.isArray(request.body.tools) && request.body.tools.length > 0;
    const contextTokensEst = estimateResponsesContextTokens(request.body);

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
        request.body.model,
        hasTools,
        false,
        contextTokensEst,
        privacyLevel,
        null,
        state.modelStatuses ?? {}
      );
    } catch (error) {
      recordRouteSelectionFailure(runtimeManager, error, {
        model: request.body.model,
        promptHash,
        stream: request.body.stream ?? false,
        hasTools,
        privacyLevel,
        contextTokensEst,
        sessionId: null,
        policyHits: ["route_selection_failed", "responses_native"]
      });
      throw error;
    }
    // selectRoute 已按 priority → score → candidateIndex 排好序，且带 runtime 对象引用
    const orderedCandidates = routeDecision.ordered;

    let attempts: TraceAttempt[] = [];
    let fallbacks: TraceCandidate[] = [];

    let providerResponse: ProviderResponse | null = null;
    // selected 恒等于实际执行过的候选，不预设为打分最高者
    let selectedCandidate: RoutedCandidate | null = null;
    let lastError: unknown;
    let sawNativeResponsesAdapter = false;
    // 流式旁路观测到的 usage（上游未发 usage 时保持 undefined）
    let streamUsage: ProviderResponse["usage"];

    const buildBaseTrace = () => ({
      trace_id: traceId,
      timestamp: new Date().toISOString(),
      session_id: null,
      request: {
        model: request.body.model!,
        normalized_model: routeDecision.normalizedModel,
        prompt_hash: promptHash,
        stream: request.body.stream ?? false,
        has_tools: Array.isArray(request.body.tools) && request.body.tools.length > 0,
        privacy_level: privacyLevel,
        context_tokens_est: estimateResponsesContextTokens(request.body),
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
      selected: selectedCandidate && attempts.length > 0
        ? {
            route_id: selectedCandidate.routeId,
            endpoint: selectedCandidate.endpoint.id,
            platform: selectedCandidate.platform.id,
            provider: selectedCandidate.provider.id,
            account_hash: sha256(selectedCandidate.account.id),
            model_id: selectedCandidate.modelId,
            model: selectedCandidate.model,
            score: selectedCandidate.score
          }
        : null,
      policy_hits: [
        "responses_native",
        ...(routeDecision.contextWindowUnknown ? ["context_window_unknown"] : [])
      ],
      attempts,
      fallbacks,
      feedback: null
    });

    const executionInput = {
      state,
      runtimeStatusService,
      candidates: orderedCandidates,
      requestHeaders: request.headers,
      // 只有实现了原生 responses 方法的 adapter 才能直通；其余候选跳过，
      // 全部跳过时降级为 Chat Completions 转换。
      supportsCandidate: (_candidate: RoutedCandidate, target: RouteTarget) => {
        const adapter = state.adapters.forProtocol(target.platform.protocol);
        return Boolean(request.body.stream ? adapter.streamResponse : adapter.responseCompletion);
      }
    };

    if (request.body.stream) {
      const outcome = {
        selected: null as RoutedCandidate | null,
        attempts: [] as TraceAttempt[],
        fallbacks: [] as TraceCandidate[],
        lastError: undefined as unknown,
        sawSupportedCandidate: false,
        partialFailure: false
      };

      const stream = streamRoutedRequest(
        {
          ...executionInput,
          invokeStream: (_candidate, target) =>
            state.adapters.forProtocol(target.platform.protocol).streamResponse!(
              {
                ...(request.body as Record<string, unknown>),
                model: request.body.model!,
                stream: true
              },
              target
            ),
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
        outcome
      );

      // 先透传字节，再旁路观测 usage：顺序保证观测失败不影响响应
      const usageTap = new StreamUsageTap();
      for await (const event of stream) {
        reply.raw.write(event.chunk.raw);
        usageTap.observe(event.chunk.raw);
      }
      usageTap.finish();
      streamUsage = usageTap.result();

      selectedCandidate = outcome.selected;
      attempts = outcome.attempts;
      fallbacks = outcome.fallbacks;
      lastError = outcome.lastError;
      sawNativeResponsesAdapter = outcome.sawSupportedCandidate;

      if (outcome.partialFailure) {
        const latencyMs = Date.now() - startedAt;
        state.traceStore.append({
          ...buildBaseTrace(),
          policy_hits: [
            "responses_native",
            "stream_partial_failed",
            ...(routeDecision.contextWindowUnknown ? ["context_window_unknown"] : [])
          ],
          execution: {
            status: "failed",
            latency_ms: latencyMs,
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
        reply.raw.end();
        return reply;
      }

      if (outcome.selected) {
        reply.raw.end();
        // 响应体已按字节透传；usage 来自只读旁路，上游未发时为 undefined
        providerResponse = { status: 200, body: null, usage: streamUsage };
      }
    } else {
      const outcome = await executeRoutedRequest({
        ...executionInput,
        invoke: (_candidate, target) =>
          state.adapters.forProtocol(target.platform.protocol).responseCompletion!(
            {
              ...(request.body as Record<string, unknown>),
              model: request.body.model!,
              stream: false
            },
            target
          )
      });

      selectedCandidate = outcome.selected;
      attempts = outcome.attempts;
      fallbacks = outcome.fallbacks;
      lastError = outcome.lastError;
      providerResponse = outcome.response;
      sawNativeResponsesAdapter = outcome.sawSupportedCandidate;
    }

    if (!sawNativeResponsesAdapter) {
      return fallbackResponsesViaChat(runtimeManager, runtimeStatusService, request, reply);
    }

    if (!providerResponse && isResponsesUnsupportedError(lastError) && !reply.raw.headersSent) {
      return fallbackResponsesViaChat(runtimeManager, runtimeStatusService, request, reply);
    }

    const latencyMs = Date.now() - startedAt;
    const usage = responsesUsageToChatUsage(providerResponse?.usage);
    const baseTrace = buildBaseTrace();

    if (!providerResponse) {
      state.traceStore.append({
        ...baseTrace,
        execution: {
          status: "failed",
          latency_ms: latencyMs,
          error: lastError instanceof Error ? lastError.message : "provider_responses_failed"
        },
        cost: {
          estimated_usd: null,
          actual_usd: null,
          price_confidence: "unknown"
        }
      });

      throw lastError instanceof Error
        ? lastError
        : new HttpError(503, "all_candidates_failed", "All candidates failed", true);
    }

    state.traceStore.append({
      ...baseTrace,
      execution: {
        status: fallbacks.length > 0 ? "success_with_fallback" : "success",
        latency_ms: latencyMs,
        input_tokens: usage?.prompt_tokens,
        output_tokens: usage?.completion_tokens,
        total_tokens: usage?.total_tokens
      },
      cost: {
        estimated_usd: null,
        actual_usd: null,
        price_confidence: "unknown"
      }
    });

    if (request.body.stream) {
      return reply;
    }

    reply.header("x-autorouter-trace-id", traceId);
    reply.header("x-autorouter-normalized-model", routeDecision.normalizedModel);

    // 原生 responses 直通：有原始字节时按字节透传
    if (providerResponse.raw !== undefined) {
      return reply.type("application/json").send(providerResponse.raw);
    }

    return providerResponse.body;
  });
}
