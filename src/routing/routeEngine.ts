import type { ModelCatalog } from "../catalog/modelCatalog.js";
import type { PriceTable } from "../catalog/priceTable.js";
import type {
  PolicyConfig,
  PolicyThresholdsConfig,
  PolicyWeightsConfig,
  RouterConfig
} from "../config/schema.js";
import type {
  AccountRuntimeState,
  EndpointRuntimeState,
  PlatformRuntimeState,
  ProviderRuntimeState
} from "../state/routerState.js";
import { HttpError } from "../utils/httpErrors.js";
import type { StickyRoute } from "./stickySession.js";

export interface SelectedRoute {
  requestedModel: string;
  normalizedModel: string;
  routeId: string;
  platform: PlatformRuntimeState;
  provider: ProviderRuntimeState;
  endpoint: EndpointRuntimeState;
  account: AccountRuntimeState;
  modelId: string;
  model: string;
  candidateIndex: number;
}

export interface CandidateEvaluation {
  routeId: string;
  platform: string;
  provider: string;
  endpoint: string;
  account: string;
  modelId: string;
  model: string;
  filteredReason?: string;
  score?: number;
  sticky?: boolean;
}

function trustLevelScore(level: string): number {
  switch (level) {
    case "high":
      return 1;
    case "medium":
      return 0.6;
    case "low":
    default:
      return 0.2;
  }
}

function normalizeScore(value: number, maxValue: number): number {
  if (maxValue <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, value / maxValue));
}

function resolvePolicy(config: RouterConfig, routeId: string): PolicyConfig {
  const routePolicyId = config.routes[routeId]?.policy ?? config.defaults.policy;
  return config.policies[routePolicyId] ?? config.policies[config.defaults.policy] ?? {
    thresholds: {
      min_trust_level: "low",
      allow_public_only_provider: false,
      require_tools: false,
      require_json_mode: false
    },
    weights: {
      health: 1,
      trust: 1,
      cost: 0,
      quality: 0,
      context: 0,
      tools: 0,
      sticky: 0,
      error_penalty: 1,
      quota_penalty: 1
    },
    min_trust_level: "low",
    allow_public_only_provider: false,
    fallback_enabled: true,
    sticky_session: false
  };
}

function canUseCandidate(
  thresholds: PolicyThresholdsConfig,
  provider: ProviderRuntimeState,
  endpoint: EndpointRuntimeState,
  account: AccountRuntimeState,
  modelContextWindow: number | undefined,
  hasTools: boolean,
  requiresJson: boolean,
  requestedContextTokens: number,
  privacyLevel: string
): string | null {
  if (!endpoint.enabled) {
    return "endpoint_disabled";
  }

  if (endpoint.health === "down") {
    return "endpoint_down";
  }

  if (!account.enabled) {
    return "account_disabled";
  }

  if (!account.available) {
    return account.disabled_message ?? account.disabled_reason ?? "account_unavailable";
  }

  if (
    privacyLevel !== "public_only" &&
    provider.privacy_level === "public_only" &&
    !thresholds.allow_public_only_provider
  ) {
    return "privacy_level_not_allowed";
  }

  if (
    (thresholds.min_trust_level === "high" && provider.trust_level !== "high") ||
    (thresholds.min_trust_level === "medium" && provider.trust_level === "low")
  ) {
    return "trust_level_not_allowed";
  }

  if (account.quota?.remaining_usd !== undefined && account.quota.remaining_usd <= 0) {
    return "quota_exhausted";
  }

  if (modelContextWindow !== undefined && requestedContextTokens > modelContextWindow) {
    return "context_window_exceeded";
  }

  if ((thresholds.require_tools || hasTools) && !endpoint.capabilities.tools) {
    return "tool_capability_not_supported";
  }

  if ((thresholds.require_json_mode || requiresJson) && !endpoint.capabilities.json_mode) {
    return "json_capability_not_supported";
  }

  if (
    thresholds.min_context_window !== undefined &&
    (modelContextWindow === undefined || modelContextWindow < thresholds.min_context_window)
  ) {
    return "context_window_not_sufficient";
  }

  return null;
}

function evaluateCandidateScore(
  weights: PolicyWeightsConfig,
  provider: ProviderRuntimeState,
  endpoint: EndpointRuntimeState,
  account: AccountRuntimeState,
  modelContextWindow: number | undefined,
  hasTools: boolean,
  requestedContextTokens: number,
  stickyRoute: StickyRoute | null | undefined,
  candidate: {
    routeId: string;
    platformId: string;
    providerId: string;
    endpointId: string;
    accountId: string;
    modelId: string;
  },
  priceTable: PriceTable
): { score: number; sticky: boolean } {
  const sticky =
    Boolean(
      stickyRoute &&
        stickyRoute.routeId === candidate.routeId &&
        stickyRoute.platformId === candidate.platformId &&
        stickyRoute.providerId === candidate.providerId &&
        stickyRoute.endpointId === candidate.endpointId &&
        stickyRoute.accountId === candidate.accountId &&
        stickyRoute.modelId === candidate.modelId
    );
  const stickyScore = sticky ? 1 : 0;

  const trustScore = trustLevelScore(provider.trust_level);
  const healthScore =
    endpoint.health === "healthy" ? 1 : endpoint.health === "degraded" ? 0.5 : 0.2;
  const quotaPressurePenalty =
    account.quota?.remaining_usd !== undefined && account.quota.remaining_usd < 1 ? 1 : 0;
  const recentErrorPenalty = normalizeScore(
    endpoint.recent_error_count + account.recent_error_count,
    10
  );
  const contextScore =
    modelContextWindow !== undefined
      ? Math.min(1, requestedContextTokens > 0
          ? modelContextWindow / Math.max(requestedContextTokens, 1)
          : 1)
      : 0;
  const toolsScore =
    hasTools ? (endpoint.capabilities.tools ? 1 : 0) : endpoint.capabilities.tools ? 0.6 : 0;
  const qualityScore =
    (endpoint.capabilities.tools ? 0.4 : 0) +
    (endpoint.capabilities.json_mode ? 0.2 : 0) +
    Math.min(0.4, contextScore * 0.4);
  const costEstimate = priceTable.estimateCost(candidate.modelId, requestedContextTokens, 512);
  const costScore =
    costEstimate.estimatedUsd === null
      ? 0
      : 1 / (1 + costEstimate.estimatedUsd * 100);

  const score =
    weights.health * healthScore +
    weights.trust * trustScore +
    weights.cost * costScore +
    weights.quality * qualityScore +
    weights.context * contextScore +
    weights.tools * toolsScore +
    weights.sticky * stickyScore -
    weights.error_penalty * recentErrorPenalty -
    weights.quota_penalty * quotaPressurePenalty;

  return {
    score,
    sticky
  };
}

export function selectRoute(
  config: RouterConfig,
  modelCatalog: ModelCatalog,
  priceTable: PriceTable,
  platforms: PlatformRuntimeState[],
  providers: ProviderRuntimeState[],
  endpoints: EndpointRuntimeState[],
  accounts: AccountRuntimeState[],
  routeId: string,
  hasTools: boolean,
  requiresJson: boolean,
  requestedContextTokens: number,
  privacyLevel: string,
  stickyRoute?: StickyRoute | null
): {
  selected: SelectedRoute;
  requestedModel: string;
  normalizedModel: string;
  candidates: CandidateEvaluation[];
  filtered: CandidateEvaluation[];
} {
  const resolvedTarget = modelCatalog.resolveRequestTarget(routeId);
  if (!resolvedTarget) {
    throw new HttpError(400, "model_not_found", `Unknown route or model: ${routeId}`, false, {
      requested_model: routeId,
      normalized_model: routeId,
      context_tokens_est: requestedContextTokens,
      filtered: [],
      candidates: []
    });
  }

  const candidates = resolvedTarget.candidates;
  if (candidates.length === 0) {
    if (resolvedTarget.mode === "provider_model") {
      throw new HttpError(
        400,
        "provider_model_not_found",
        `Unknown provider/model target: ${routeId}`,
        false,
        {
          requested_model: resolvedTarget.requested,
          normalized_model: resolvedTarget.normalized,
          context_tokens_est: requestedContextTokens,
          filtered: [],
          candidates: []
        }
      );
    }

    throw new HttpError(400, "model_not_found", `Unknown route or model: ${routeId}`, false, {
      requested_model: resolvedTarget.requested,
      normalized_model: resolvedTarget.normalized,
      context_tokens_est: requestedContextTokens,
      filtered: [],
      candidates: []
    });
  }

  const evaluations: CandidateEvaluation[] = [];
  const filtered: CandidateEvaluation[] = [];
  const passed: Array<SelectedRoute & { score: number }> = [];
  const effectiveRouteId =
    resolvedTarget.mode === "route_alias" ? resolvedTarget.requested : config.defaults.model;
  const policy = resolvePolicy(config, effectiveRouteId);
  const thresholds = policy.thresholds;
  const weights = policy.weights;

  for (const [index, candidate] of candidates.entries()) {
    const endpoint = endpoints.find((item) => item.id === candidate.endpoint);
    const provider = endpoint
      ? providers.find((item) => item.id === endpoint.provider_id)
      : undefined;
    const platform = endpoint
      ? platforms.find((item) => item.id === endpoint.platform_id)
      : undefined;
    const account = accounts.find((item) => item.id === candidate.account);
    const modelDefinition = modelCatalog.resolveModel(candidate.modelId);

    if (!endpoint || !provider || !platform || !account || !modelDefinition) {
      filtered.push({
        routeId: candidate.routeId,
        platform: platform?.id ?? "unknown",
        provider: provider?.id ?? "unknown",
        endpoint: candidate.endpoint,
        account: candidate.account,
        modelId: candidate.modelId,
        model: candidate.model,
        filteredReason: "candidate_not_found"
      });
      continue;
    }

    const filteredReason = canUseCandidate(
      thresholds,
      provider,
      endpoint,
      account,
      modelDefinition.context_window,
      hasTools,
      requiresJson,
      requestedContextTokens,
      privacyLevel
    );
    if (filteredReason) {
      filtered.push({
        routeId: candidate.routeId,
        platform: platform.id,
        provider: provider.id,
        endpoint: endpoint.id,
        account: candidate.account,
        modelId: candidate.modelId,
        model: candidate.model,
        filteredReason
      });
      continue;
    }

    const { score, sticky } = evaluateCandidateScore(
      weights,
      provider,
      endpoint,
      account,
      modelDefinition.context_window,
      hasTools,
      requestedContextTokens,
      stickyRoute,
      {
        routeId: candidate.routeId,
        platformId: platform.id,
        providerId: provider.id,
        endpointId: endpoint.id,
        accountId: account.id,
        modelId: candidate.modelId
      },
      priceTable
    );

    evaluations.push({
      routeId: candidate.routeId,
      platform: platform.id,
      provider: provider.id,
      endpoint: endpoint.id,
      account: candidate.account,
      modelId: candidate.modelId,
      model: candidate.model,
      score,
      sticky
    });
    passed.push({
      routeId: candidate.routeId,
      requestedModel: resolvedTarget.requested,
      normalizedModel: resolvedTarget.normalized,
      platform,
      provider,
      endpoint,
      account,
      modelId: candidate.modelId,
      model: candidate.model,
      candidateIndex: index,
      score
    });
  }

  if (passed.length === 0) {
    throw new HttpError(503, "endpoint_unavailable", "No eligible route candidate", false, {
      requested_model: resolvedTarget.requested,
      normalized_model: resolvedTarget.normalized,
      context_tokens_est: requestedContextTokens,
      filtered: filtered.map((candidate) => ({
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
      candidates: evaluations.map((candidate) => ({
        route_id: candidate.routeId,
        endpoint: candidate.endpoint,
        platform: candidate.platform,
        provider: candidate.provider,
        account: candidate.account,
        model_id: candidate.modelId,
        model: candidate.model,
        score: candidate.score,
        sticky: candidate.sticky
      }))
    });
  }

  passed.sort((left, right) => right.score - left.score);

  return {
    selected: passed[0],
    requestedModel: resolvedTarget.requested,
    normalizedModel: resolvedTarget.normalized,
    candidates: evaluations,
    filtered
  };
}
