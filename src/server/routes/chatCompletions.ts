import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import type { ModelCatalog } from "../../catalog/modelCatalog.js";
import { selectRoute } from "../../routing/routeEngine.js";
import type { RouterState } from "../../state/routerState.js";
import { sha256 } from "../../utils/hash.js";
import { HttpError } from "../../utils/httpErrors.js";
import { normalizeChatRequest } from "../../routing/normalizeRequest.js";
import type { ChatCompletionsRequestBody } from "../../routing/types.js";

export async function registerChatCompletionsRoute(
  fastify: FastifyInstance,
  state: RouterState,
  modelCatalog: ModelCatalog
) {
  fastify.post<{ Body: ChatCompletionsRequestBody }>("/v1/chat/completions", async (request, reply) => {
    const normalizedRequest = normalizeChatRequest(request.body);
    const sessionId =
      typeof normalizedRequest.metadata.session_id === "string"
        ? normalizedRequest.metadata.session_id
        : typeof request.headers["x-auto-router-session-id"] === "string"
          ? request.headers["x-auto-router-session-id"]
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
      state.endpoints,
      state.accounts,
      normalizedRequest.model,
      normalizedRequest.tools.length > 0,
      normalizedRequest.response_format !== undefined,
      privacyLevel,
      sessionId ? state.stickySessions.get(sessionId) : null
    );
    const traceId = randomUUID();
    const startedAt = Date.now();
    const promptHash = sha256(JSON.stringify(normalizedRequest.messages));
    const orderedCandidates = routeDecision.candidates
      .map((candidate) => {
        const endpoint = state.endpoints.find((item) => item.id === candidate.endpoint);
        const platform = state.platforms.find((item) => item.id === candidate.platform);
        const account = state.accounts.find(
          (item) => item.endpoint_id === candidate.endpoint && item.id === candidate.account
        );

        return {
          endpoint,
          platform,
          account,
          model: candidate.model,
          score: candidate.score ?? 0
        };
      })
      .filter(
        (
          candidate
        ): candidate is {
          endpoint: NonNullable<(typeof candidate)["endpoint"]>;
          platform: NonNullable<(typeof candidate)["platform"]>;
          account: NonNullable<(typeof candidate)["account"]>;
          model: string;
          score: number;
        } => Boolean(candidate.endpoint && candidate.platform && candidate.account)
      )
      .sort((left, right) => right.score - left.score);

    let providerResponse;
    let selectedRoute = routeDecision.selected;
    const fallbackHistory: Array<{ endpoint: string; platform: string; account: string; model: string }> = [];
    let lastError: unknown;

    for (const [index, candidate] of orderedCandidates.entries()) {
      const endpointConfig = state.config.endpoints[candidate.endpoint.id];
      const accountConfig = endpointConfig.accounts.find(
        (account) => account.id === candidate.account.id
      );

      if (!accountConfig) {
        lastError = new HttpError(500, "account_not_found", "Configured account missing");
        continue;
      }

      const apiKey = accountConfig.api_key_env
        ? process.env[accountConfig.api_key_env]
        : undefined;
      const adapter = state.adapters.get(endpointConfig.protocol);

      try {
        if (normalizedRequest.stream && adapter.streamChatCompletion) {
          reply.header("content-type", "text/event-stream; charset=utf-8");
          reply.header("cache-control", "no-cache");
          reply.header("connection", "keep-alive");
          reply.header("x-auto-router-trace-id", traceId);
          reply.header("x-auto-router-endpoint", candidate.endpoint.id);
          reply.header("x-auto-router-platform", candidate.platform.id);
          reply.header("x-auto-router-model", candidate.model);
          reply.header("x-auto-router-account", candidate.account.id);

          for await (const chunk of adapter.streamChatCompletion(normalizedRequest, {
            endpointId: candidate.endpoint.id,
            platformId: candidate.platform.id,
            accountId: candidate.account.id,
            model: candidate.model,
            endpointConfig,
            apiKey
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
            endpointId: candidate.endpoint.id,
            platformId: candidate.platform.id,
            accountId: candidate.account.id,
            model: candidate.model,
            endpointConfig,
            apiKey
          });
        }
        selectedRoute = {
          platform: candidate.platform,
          endpoint: candidate.endpoint,
          account: candidate.account,
          model: candidate.model,
          candidateIndex: index
        };
        break;
      } catch (error) {
        lastError = error;
        candidate.endpoint.recent_error_count += 1;
        candidate.account.recent_error_count += 1;

        if (error instanceof HttpError && error.code === "provider_auth_failed") {
          candidate.account.available = false;
          candidate.account.disabled_reason = "provider_auth_failed";
        }

        if (!(error instanceof HttpError) || !error.retryable) {
          break;
        }

        if (index < orderedCandidates.length - 1) {
          fallbackHistory.push({
            endpoint: candidate.endpoint.id,
            platform: candidate.platform.id,
            account: candidate.account.id,
            model: candidate.model
          });
        }

      }
    }

    if (!providerResponse) {
      const latencyMs = Date.now() - startedAt;
      state.traceStore.append({
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        request: {
          model: normalizedRequest.model,
          prompt_hash: promptHash,
          stream: normalizedRequest.stream,
          has_tools: normalizedRequest.tools.length > 0,
          privacy_level: privacyLevel
        },
        candidates: routeDecision.candidates.map((candidate) => ({
          endpoint: candidate.endpoint,
          platform: candidate.platform,
          account: candidate.account,
          model: candidate.model
        })),
        filtered: routeDecision.filtered.map((candidate) => ({
          endpoint: candidate.endpoint,
          platform: candidate.platform,
          account: candidate.account,
          model: candidate.model,
          reason: candidate.filteredReason
        })),
        selected: {
          endpoint: selectedRoute.endpoint.id,
          platform: selectedRoute.platform.id,
          account_hash: sha256(selectedRoute.account.id),
          model: selectedRoute.model
        },
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
        },
        fallbacks: fallbackHistory
      });
      throw lastError instanceof Error
        ? lastError
        : new HttpError(503, "all_candidates_failed", "All candidates failed", true);
    }

    const latencyMs = Date.now() - startedAt;
    const priceEstimate = state.priceTable.estimateCost(
      selectedRoute.endpoint.id,
      selectedRoute.model,
      providerResponse.usage?.prompt_tokens,
      providerResponse.usage?.completion_tokens
    );

    if (sessionId) {
      state.stickySessions.set(sessionId, {
        endpointId: selectedRoute.endpoint.id,
        accountId: selectedRoute.account.id,
        model: selectedRoute.model
      });
    }

    state.traceStore.append({
      trace_id: traceId,
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      request: {
        model: normalizedRequest.model,
        prompt_hash: promptHash,
        stream: normalizedRequest.stream,
        has_tools: normalizedRequest.tools.length > 0,
        privacy_level: privacyLevel
      },
      candidates: routeDecision.candidates.map((candidate) => ({
        endpoint: candidate.endpoint,
        platform: candidate.platform,
        account: candidate.account,
        model: candidate.model
      })),
      filtered: routeDecision.filtered.map((candidate) => ({
        endpoint: candidate.endpoint,
        platform: candidate.platform,
        account: candidate.account,
        model: candidate.model,
        reason: candidate.filteredReason
      })),
      selected: {
        endpoint: selectedRoute.endpoint.id,
        platform: selectedRoute.platform.id,
        account_hash: sha256(selectedRoute.account.id),
        model: selectedRoute.model
      },
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
      },
      fallbacks: fallbackHistory
    });

    if (normalizedRequest.stream) {
      return reply;
    }

    reply.header("x-auto-router-trace-id", traceId);
    reply.header("x-auto-router-endpoint", selectedRoute.endpoint.id);
    reply.header("x-auto-router-platform", selectedRoute.platform.id);
    reply.header("x-auto-router-model", selectedRoute.model);
    reply.header("x-auto-router-account", selectedRoute.account.id);

    return providerResponse.body;
  });
}
