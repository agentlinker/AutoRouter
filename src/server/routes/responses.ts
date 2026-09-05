import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { selectRoute } from "../../routing/routeEngine.js";
import {
  executeRoutedRequest,
  streamRoutedRequest,
  type RoutedCandidate
} from "../../routing/executeRoutedRequest.js";
import { StreamUsageTap } from "../../routing/streamUsageTap.js";
import type { ProviderResponse, RouteTarget } from "../../providers/adapter.js";
import type { TraceAttempt, TraceCandidate } from "../../trace/traceTypes.js";
import { estimateResponsesContextTokens as estimateResponsesContextTokensUtil } from "../../utils/contextTokens.js";
import { recordRouteSelectionFailure } from "./routeSelectionFailure.js";
import { sha256 } from "../../utils/hash.js";
import { HttpError } from "../../utils/httpErrors.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import type { RuntimeStatusService } from "../../runtime/runtimeStatusService.js";
import { resolveUpstreamUrl } from "../../providers/upstreamUrl.js";

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
        state.modelStatuses ?? {},
        "openai-responses"
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
      attemptMetadata: (_candidate: RoutedCandidate, target: RouteTarget) => ({
        actual_upstream_url: resolveUpstreamUrl(target.endpoint.base_url, "responses")
      })
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
