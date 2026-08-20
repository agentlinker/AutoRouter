import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { selectRoute } from "../../routing/routeEngine.js";
import {
  executeRoutedRequest,
  streamRoutedRequest,
  type RoutedCandidate
} from "../../routing/executeRoutedRequest.js";
import { sha256 } from "../../utils/hash.js";
import { HttpError } from "../../utils/httpErrors.js";
import { normalizeChatRequest } from "../../routing/normalizeRequest.js";
import { StreamUsageTap } from "../../routing/streamUsageTap.js";
import type { ChatCompletionsRequestBody } from "../../routing/types.js";
import type { ProviderResponse } from "../../providers/adapter.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import type { RuntimeStatusService } from "../../runtime/runtimeStatusService.js";
import type { TraceAttempt, TraceCandidate } from "../../trace/traceTypes.js";
import { recordRouteSelectionFailure } from "./routeSelectionFailure.js";

export async function registerChatCompletionsRoute(
  fastify: FastifyInstance,
  runtimeManager: RuntimeManagerLike,
  runtimeStatusService?: RuntimeStatusService
) {
  fastify.post<{ Body: ChatCompletionsRequestBody }>("/v1/chat/completions", async (request, reply) => {
    const state = runtimeManager.getSnapshot();
    const { modelCatalog } = state;
    const normalizedRequest = normalizeChatRequest(request.body);
    const sessionId =
      typeof normalizedRequest.metadata.session_id === "string"
        ? normalizedRequest.metadata.session_id
        : typeof request.headers["x-autorouter-session-id"] === "string"
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

    let routeDecision;
    try {
      routeDecision = selectRoute(
        state.config,
        modelCatalog,
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
        // 入站是 Chat Completions，优先选 openai 协议的 endpoint（零转换透传）
        "openai"
      );
    } catch (error) {
      recordRouteSelectionFailure(runtimeManager, error, {
        model: normalizedRequest.model,
        promptHash,
        stream: normalizedRequest.stream,
        hasTools,
        privacyLevel,
        contextTokensEst: normalizedRequest.context_tokens_est,
        sessionId,
        policyHits: ["route_selection_failed"]
      });
      throw error;
    }

    // selectRoute 已按 priority → score → candidateIndex 排好序，且带 runtime 对象引用
    const orderedCandidates = routeDecision.ordered;

    let providerResponse: ProviderResponse | null = null;
    let selectedRoute: RoutedCandidate | null = null;
    let attemptHistory: TraceAttempt[] = [];
    let fallbackHistory: TraceCandidate[] = [];
    let lastError: unknown;

    // 显式要求了上下文窗口但候选元数据缺失时留下观测标记（宽松策略，不过滤候选）
    const withPolicyHits = (...hits: string[]) => [
      ...hits,
      ...(routeDecision.contextWindowUnknown ? ["context_window_unknown"] : []),
      // 没有同协议候选说明只能走 anthropic→openai 转换，值得在 trace 里留痕
      ...(routeDecision.sawProtocolMatch ? [] : ["protocol_mismatch"])
    ];

    const buildBaseTrace = () => {
      return {
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        request: {
          model: normalizedRequest.model,
          normalized_model: routeDecision.normalizedModel,
          prompt_hash: promptHash,
          stream: normalizedRequest.stream,
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
        // selected 恒等于实际执行过的候选
        selected: selectedRoute
          ? {
              route_id: selectedRoute.routeId,
              endpoint: selectedRoute.endpoint.id,
              platform: selectedRoute.platform.id,
              provider: selectedRoute.provider.id,
              account_hash: sha256(selectedRoute.account.id),
              model_id: selectedRoute.modelId,
              model: selectedRoute.model,
              score: selectedRoute.score
            }
          : null,
        attempts: attemptHistory,
        fallbacks: fallbackHistory,
        feedback: null
      };
    };

    const executionInput = {
      state,
      runtimeStatusService,
      candidates: orderedCandidates,
      requestHeaders: request.headers
    };

    if (normalizedRequest.stream) {
      // 流式：字节透传，一旦写出就不能再 fallback
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
          supportsCandidate: (_candidate, target) =>
            Boolean(state.adapters.forProtocol(target.platform.protocol).streamChatCompletion),
          invokeStream: (_candidate, target) =>
            state.adapters
              .forProtocol(target.platform.protocol)
              .streamChatCompletion!(normalizedRequest, target),
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

      selectedRoute = outcome.selected;
      attemptHistory = outcome.attempts;
      fallbackHistory = outcome.fallbacks;
      lastError = outcome.lastError;

      // 字节已在途，只能结束响应并把失败落 trace
      if (outcome.partialFailure) {
        const latencyMs = Date.now() - startedAt;
        state.traceStore.append({
          ...buildBaseTrace(),
          policy_hits: withPolicyHits(
            ...(sessionId ? ["session_sticky"] : []),
            "stream_partial_failed"
          ),
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
        providerResponse = { status: 200, body: null, usage: usageTap.result() };
      }
    } else {
      const outcome = await executeRoutedRequest({
        ...executionInput,
        invoke: (_candidate, target) =>
          state.adapters.forProtocol(target.platform.protocol).chatCompletion(
            normalizedRequest,
            target
          )
      });

      selectedRoute = outcome.selected;
      attemptHistory = outcome.attempts;
      fallbackHistory = outcome.fallbacks;
      lastError = outcome.lastError;
      providerResponse = outcome.response;
    }

    const baseTrace = buildBaseTrace();

    if (!providerResponse || !selectedRoute) {
      const latencyMs = Date.now() - startedAt;
      state.traceStore.append({
        ...baseTrace,
        policy_hits: withPolicyHits(
          ...(sessionId ? ["session_sticky"] : []),
          "fallback_chain"
        ),
        execution: {
          status: "failed",
          latency_ms: latencyMs,
          error:
            lastError instanceof Error ? lastError.message : "provider_request_failed"
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

    const latencyMs = Date.now() - startedAt;
    const priceEstimate = state.priceTable.estimateCost(
      selectedRoute.modelId,
      providerResponse.usage?.prompt_tokens,
      providerResponse.usage?.completion_tokens
    );

    if (sessionId) {
      state.stickySessions.set(sessionId, {
        routeId: selectedRoute.routeId,
        platformId: selectedRoute.platform.id,
        providerId: selectedRoute.provider.id,
        endpointId: selectedRoute.endpoint.id,
        accountId: selectedRoute.account.id,
        modelId: selectedRoute.modelId
      });
    }

    state.traceStore.append({
      ...baseTrace,
      policy_hits: withPolicyHits(...(sessionId ? ["session_sticky"] : [])),
      execution: {
        status: fallbackHistory.length > 0 ? "success_with_fallback" : "success",
        latency_ms: latencyMs,
        input_tokens: providerResponse.usage?.prompt_tokens,
        output_tokens: providerResponse.usage?.completion_tokens,
        total_tokens: providerResponse.usage?.total_tokens
      },
      cost: {
        estimated_usd: priceEstimate.estimatedUsd,
        actual_usd: null,
        price_confidence: priceEstimate.confidence
      }
    });

    if (normalizedRequest.stream) {
      return reply;
    }

    reply.header("x-autorouter-trace-id", traceId);
    reply.header("x-autorouter-normalized-model", selectedRoute.normalizedModel);

    // 有原始字节时按字节透传，保住上游响应里 AutoRouter 未建模的字段与数字精度
    if (providerResponse.raw !== undefined) {
      return reply.type("application/json").send(providerResponse.raw);
    }

    return providerResponse.body;
  });
}
