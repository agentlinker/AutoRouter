import { randomUUID } from "node:crypto";

import type { RuntimeManagerLike } from "../../runtime/runtimeTypes.js";
import type { TraceCandidate } from "../../trace/traceTypes.js";
import { isHttpError, type HttpError } from "../../utils/httpErrors.js";

function asTraceCandidates(value: unknown): TraceCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    if (typeof record.endpoint !== "string" || typeof record.model !== "string") {
      return [];
    }

    return [
      {
        route_id: typeof record.route_id === "string" ? record.route_id : undefined,
        endpoint: record.endpoint,
        platform: typeof record.platform === "string" ? record.platform : "unknown",
        provider: typeof record.provider === "string" ? record.provider : undefined,
        account: typeof record.account === "string" ? record.account : "unknown",
        model_id: typeof record.model_id === "string" ? record.model_id : undefined,
        model: record.model,
        reason: typeof record.reason === "string" ? record.reason : undefined,
        score: typeof record.score === "number" ? record.score : undefined,
        sticky: typeof record.sticky === "boolean" ? record.sticky : undefined
      }
    ];
  });
}

export function recordRouteSelectionFailure(
  runtimeManager: RuntimeManagerLike,
  error: unknown,
  input: {
    model: string;
    promptHash: string;
    stream: boolean;
    hasTools: boolean;
    privacyLevel: string;
    contextTokensEst: number;
    sessionId?: string | null;
    policyHits?: string[];
  }
): void {
  if (!isHttpError(error)) {
    return;
  }

  // Only persist selection failures that have structured routing details.
  if (
    error.code !== "endpoint_unavailable" &&
    error.code !== "model_not_found" &&
    error.code !== "provider_model_not_found"
  ) {
    return;
  }

  const details = error.details ?? {};
  const normalizedModel =
    typeof details.normalized_model === "string" ? details.normalized_model : input.model;
  const contextTokensEst =
    typeof details.context_tokens_est === "number"
      ? details.context_tokens_est
      : input.contextTokensEst;

  runtimeManager.getSnapshot().traceStore.append({
    trace_id: randomUUID(),
    timestamp: new Date().toISOString(),
    session_id: input.sessionId ?? null,
    request: {
      model: input.model,
      normalized_model: normalizedModel,
      prompt_hash: input.promptHash,
      stream: input.stream,
      has_tools: input.hasTools,
      privacy_level: input.privacyLevel,
      context_tokens_est: contextTokensEst
    },
    candidates: asTraceCandidates(details.candidates),
    filtered: asTraceCandidates(details.filtered),
    selected: null,
    policy_hits: input.policyHits ?? ["route_selection_failed"],
    execution: {
      status: "failed",
      latency_ms: 0,
      error: error.message
    },
    cost: {
      estimated_usd: null,
      actual_usd: null,
      price_confidence: "unknown"
    },
    attempts: [],
    fallbacks: [],
    feedback: null
  });
}

export function isRouteSelectionHttpError(error: unknown): error is HttpError {
  return (
    isHttpError(error) &&
    (error.code === "endpoint_unavailable" ||
      error.code === "model_not_found" ||
      error.code === "provider_model_not_found")
  );
}
