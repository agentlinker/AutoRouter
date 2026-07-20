import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { selectRoute } from "../../routing/routeEngine.js";
import { sha256 } from "../../utils/hash.js";
import { HttpError } from "../../utils/httpErrors.js";
import { PROVIDER_AUTH_FAILED_CODE, PROVIDER_AUTH_FAILED_MESSAGE } from "../../utils/providerErrors.js";
import { normalizeChatRequest } from "../../routing/normalizeRequest.js";
import type { ChatCompletionsRequestBody } from "../../routing/types.js";
import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";

export async function registerChatCompletionsRoute(
  fastify: FastifyInstance,
  runtimeManager: RuntimeManagerLike
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

    const routeDecision = selectRoute(
      state.config,
      modelCatalog,
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
      sessionId ? state.stickySessions.get(sessionId) : null
    );

    const traceId = randomUUID();
    const startedAt = Date.now();
    const promptHash = sha256(JSON.stringify(normalizedRequest.messages));

    const orderedCandidates = routeDecision.candidates
      .map((candidate) => {
        const provider = state.providers.find((item) => item.id === candidate.provider);
        const endpoint = state.endpoints.find((item) => item.id === candidate.endpoint);
        const platform = state.platforms.find((item) => item.id === candidate.platform);
        const account = state.accounts.find((item) => item.id === candidate.account);
        const model = modelCatalog.resolveModel(candidate.modelId);

        return {
          routeId: candidate.routeId,
          provider,
          endpoint,
          platform,
          account,
          modelId: candidate.modelId,
          model,
          modelName: candidate.model,
          score: candidate.score ?? 0
        };
      })
      .filter(
        (
          candidate
        ): candidate is {
          routeId: string;
          provider: NonNullable<(typeof candidate)["provider"]>;
          endpoint: NonNullable<(typeof candidate)["endpoint"]>;
          platform: NonNullable<(typeof candidate)["platform"]>;
          account: NonNullable<(typeof candidate)["account"]>;
          modelId: string;
          model: NonNullable<(typeof candidate)["model"]>;
          modelName: string;
          score: number;
        } =>
          Boolean(
            candidate.provider &&
              candidate.endpoint &&
              candidate.platform &&
              candidate.account &&
              candidate.model
          )
      )
      .sort((left, right) => right.score - left.score);
    const selectedCandidateScore =
      orderedCandidates.find(
        (candidate) =>
          candidate.routeId === routeDecision.selected.routeId &&
          candidate.account.id === routeDecision.selected.account.id &&
          candidate.modelId === routeDecision.selected.modelId
      )?.score ?? 0;

    let providerResponse;
    let selectedRoute = routeDecision.selected;
    const attemptHistory: Array<{
      route_id: string;
      endpoint: string;
      platform: string;
      provider: string;
      account: string;
      model_id: string;
      model: string;
      status: "success" | "failed";
      error?: string;
      retryable?: boolean;
      score?: number;
      sticky?: boolean;
    }> = [];
    const fallbackHistory: Array<{
      route_id: string;
      endpoint: string;
      platform: string;
      provider: string;
      account: string;
      model_id: string;
      model: string;
      score?: number;
      sticky?: boolean;
    }> = [];
    let lastError: unknown;

    for (const [index, candidate] of orderedCandidates.entries()) {
      const accountConfig = state.config.accounts[candidate.account.id];
      if (!accountConfig) {
        lastError = new HttpError(500, "account_not_found", "Configured account missing");
        continue;
      }

      const credential = state.credentialStore.resolve(candidate.account.id, accountConfig);
      const adapter = state.adapters.get(candidate.endpoint.adapter as never);

      try {
        if (normalizedRequest.stream && adapter.streamChatCompletion) {
          reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
          reply.raw.setHeader("cache-control", "no-cache");
          reply.raw.setHeader("connection", "keep-alive");
          reply.raw.setHeader("x-autorouter-trace-id", traceId);
          reply.raw.setHeader("x-autorouter-normalized-model", routeDecision.normalizedModel);

          for await (const chunk of adapter.streamChatCompletion(normalizedRequest, {
            platform: candidate.platform,
            provider: candidate.provider,
            endpoint: candidate.endpoint,
            account: candidate.account,
            modelId: candidate.modelId,
            model: candidate.model,
            credential
          })) {
            reply.raw.write(chunk.raw);
          }
          reply.raw.end();

          providerResponse = {
            status: 200,
            body: null,
            usage: undefined
          };
        } else {
          providerResponse = await adapter.chatCompletion(normalizedRequest, {
            platform: candidate.platform,
            provider: candidate.provider,
            endpoint: candidate.endpoint,
            account: candidate.account,
            modelId: candidate.modelId,
            model: candidate.model,
            credential
          });
        }

        attemptHistory.push({
          route_id: candidate.routeId,
          endpoint: candidate.endpoint.id,
          platform: candidate.platform.id,
          provider: candidate.provider.id,
          account: candidate.account.id,
          model_id: candidate.modelId,
          model: candidate.modelName,
          status: "success",
          score: candidate.score,
          sticky: false
        });
        selectedRoute = {
          requestedModel: routeDecision.requestedModel,
          normalizedModel: routeDecision.normalizedModel,
          routeId: candidate.routeId,
          platform: candidate.platform,
          provider: candidate.provider,
          endpoint: candidate.endpoint,
          account: candidate.account,
          modelId: candidate.modelId,
          model: candidate.modelName,
          candidateIndex: index
        };
        break;
      } catch (error) {
        lastError = error;
        candidate.endpoint.recent_error_count += 1;
        candidate.account.recent_error_count += 1;
        const retryable = error instanceof HttpError && error.retryable;

        attemptHistory.push({
          route_id: candidate.routeId,
          endpoint: candidate.endpoint.id,
          platform: candidate.platform.id,
          provider: candidate.provider.id,
          account: candidate.account.id,
          model_id: candidate.modelId,
          model: candidate.modelName,
          status: "failed",
          error: error instanceof Error ? error.message : "provider_request_failed",
          retryable,
          score: candidate.score,
          sticky: false
        });

        if (error instanceof HttpError && error.code === PROVIDER_AUTH_FAILED_CODE) {
          candidate.account.available = false;
          candidate.account.disabled_reason = PROVIDER_AUTH_FAILED_CODE;
          candidate.account.disabled_message = error.message || PROVIDER_AUTH_FAILED_MESSAGE;
        }

        if (!retryable) {
          break;
        }

        if (index < orderedCandidates.length - 1) {
          fallbackHistory.push({
            route_id: candidate.routeId,
            endpoint: candidate.endpoint.id,
            platform: candidate.platform.id,
            provider: candidate.provider.id,
            account: candidate.account.id,
            model_id: candidate.modelId,
            model: candidate.modelName,
            score: candidate.score,
            sticky: false
          });
        }
      }
    }

    const baseTrace = {
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
        context_tokens_est: normalizedRequest.context_tokens_est
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
      selected: {
        route_id: selectedRoute.routeId,
        endpoint: selectedRoute.endpoint.id,
        platform: selectedRoute.platform.id,
        provider: selectedRoute.provider.id,
        account_hash: sha256(selectedRoute.account.id),
        model_id: selectedRoute.modelId,
        model: selectedRoute.model,
        score: selectedCandidateScore
      },
      attempts: attemptHistory,
      fallbacks: fallbackHistory,
      feedback: null
    };

    if (!providerResponse) {
      const latencyMs = Date.now() - startedAt;
      state.traceStore.append({
        ...baseTrace,
        policy_hits: sessionId ? ["session_sticky", "fallback_chain"] : ["fallback_chain"],
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
      policy_hits: sessionId ? ["session_sticky"] : [],
      execution: {
        status: "success",
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

    return providerResponse.body;
  });
}
