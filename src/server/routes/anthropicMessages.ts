import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import {
  executeRoutedRequest,
  streamRoutedRequest,
  type RoutedCandidate
} from "../../routing/executeRoutedRequest.js";
import { selectRoute } from "../../routing/routeEngine.js";
import { StreamUsageTap } from "../../routing/streamUsageTap.js";
import type { MessagesAdapter, RouteTarget } from "../../providers/adapter.js";
import { AnthropicStreamValidator } from "../../providers/anthropicStreamValidator.js";
import { resolveUpstreamUrl } from "../../providers/upstreamUrl.js";
import { sha256 } from "../../utils/hash.js";
import { HttpError } from "../../utils/httpErrors.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import type { RuntimeStatusService } from "../../runtime/runtimeStatusService.js";
import type { TraceAttempt, TraceCandidate } from "../../trace/traceTypes.js";
import { recordRouteSelectionFailure } from "./routeSelectionFailure.js";
import { estimateContextTokens } from "../../utils/contextTokens.js";

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












export async function registerAnthropicMessagesRoute(
  fastify: FastifyInstance,
  runtimeManager: RuntimeManagerLike,
  runtimeStatusService?: RuntimeStatusService
) {
  fastify.post<{ Body: AnthropicMessagesRequestBody }>("/v1/messages", async (request, reply) => {
    const state = runtimeManager.getSnapshot();
    if (!request.body.model || !Array.isArray(request.body.messages) || request.body.messages.length === 0) {
      throw new HttpError(400, "invalid_request", "model and messages are required");
    }
    const contextTokensEst = estimateContextTokens({
      content: [request.body.system, request.body.messages],
      tools: request.body.tools,
      metadata: request.body.metadata
    });
    const sessionId =
      typeof request.headers["x-autorouter-session-id"] === "string"
        ? request.headers["x-autorouter-session-id"]
        : null;
    const privacyLevel =
      typeof request.body.metadata?.privacy_level === "string"
        ? request.body.metadata.privacy_level
        : state.config.defaults.privacy_level;

    const traceId = randomUUID();
    const startedAt = Date.now();
    const promptHash = sha256(JSON.stringify([request.body.system, request.body.messages]));
    const hasTools = Array.isArray(request.body.tools) && request.body.tools.length > 0;
    const clientWantsStream = request.body.stream === true;

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
        sessionId ? state.stickySessions.get(sessionId) : null,
        state.modelStatuses ?? {},
        "anthropic-messages",
        state.accountEndpoints,
        state.poolCursors
      );
    } catch (error) {
      recordRouteSelectionFailure(runtimeManager, error, {
        model: request.body.model,
        promptHash,
        stream: clientWantsStream,
        hasTools,
        privacyLevel,
        contextTokensEst,
        sessionId,
        policyHits: ["anthropic_inbound", "route_selection_failed"],
        requiredProtocol: "anthropic-messages"
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
        stream: clientWantsStream,
        has_tools: hasTools,
        privacy_level: privacyLevel,
        context_tokens_est: contextTokensEst,
        requested_context_window: routeDecision.requestedContextWindow ?? null,
        required_protocol: "anthropic-messages"
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

    const streamValidators = new Map<string, AnthropicStreamValidator>();
    const candidateValidationKey = (candidate: RoutedCandidate) =>
      `${candidate.account.id}|${candidate.endpoint.id}|${candidate.modelId}`;
    const streamForCandidate = (
      candidate: RoutedCandidate,
      adapter: MessagesAdapter,
      target: RouteTarget
    ) => {
      const validator = new AnthropicStreamValidator();
      streamValidators.set(candidateValidationKey(candidate), validator);
      const upstream = adapter.streamMessage(nativeMessagesRequest(), target);

      return (async function* () {
        for await (const chunk of upstream) {
          validator.observe(chunk.raw);
          yield chunk;
        }
        validator.finish();
      })();
    };

    if (clientWantsStream) {
      const streamOutcome = {
        selected: null as RoutedCandidate | null,
        attempts: [] as TraceAttempt[],
        fallbacks: [] as TraceCandidate[],
        lastError: undefined as unknown,
        partialFailure: false
      };

      const stream = streamRoutedRequest(
        {
          state,
          runtimeStatusService,
          candidates: routeDecision.ordered,
          requestHeaders: request.headers,
          attemptMetadata: (candidate, target) => {
            const validation = streamValidators.get(candidateValidationKey(candidate))?.result();
            return {
              actual_upstream_url: resolveUpstreamUrl(
                target.endpoint.base_url,
                "messages"
              ),
              stream_completed: validation?.completed ?? false,
              stream_terminal_event: validation?.terminalEvent ?? null
            };
          },
          invokeStream: (candidate, target) =>
            streamForCandidate(
              candidate,
              state.adapters.forProtocol("anthropic-messages"),
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
          ...(sessionId
            ? [routeDecision.stickyHit ? "sticky_hit" : "session_present"]
            : []),
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
      attemptMetadata: (_candidate, target) => {
        return {
          actual_upstream_url: resolveUpstreamUrl(
            target.endpoint.base_url,
            "messages"
          )
        };
      },
      invoke: (_candidate, target) =>
        state.adapters.forProtocol("anthropic-messages").messageCompletion(nativeMessagesRequest(), target)
    });

    const baseTrace = buildTraceBase(outcome.selected, outcome.attempts, outcome.fallbacks);

    const policyHits = [
      "anthropic_inbound",
      "anthropic_native",
      ...(sessionId
        ? [routeDecision.stickyHit ? "sticky_hit" : "session_present"]
        : []),
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
    if (outcome.response.raw !== undefined) {
      return reply.type("application/json").send(outcome.response.raw);
    }

    return outcome.response.body;
  });
}
