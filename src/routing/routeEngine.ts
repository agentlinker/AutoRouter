import type { ModelCatalog } from "../catalog/modelCatalog.js";
import type { PriceTable } from "../catalog/priceTable.js";
import type { RouterConfig } from "../config/schema.js";
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

function canUseCandidate(
  config: RouterConfig,
  provider: ProviderRuntimeState,
  endpoint: EndpointRuntimeState,
  account: AccountRuntimeState,
  modelContextWindow: number | undefined,
  hasTools: boolean,
  requiresJson: boolean,
  requestedContextTokens: number,
  privacyLevel: string,
  minTrustLevel: string
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
    return "account_unavailable";
  }

  if (
    privacyLevel !== "public_only" &&
    provider.privacy_level === "public_only" &&
    !config.policies[config.defaults.policy]?.allow_public_only_provider
  ) {
    return "privacy_level_not_allowed";
  }

  if (
    (minTrustLevel === "high" && provider.trust_level !== "high") ||
    (minTrustLevel === "medium" && provider.trust_level === "low")
  ) {
    return "trust_level_not_allowed";
  }

  if (account.quota?.remaining_usd !== undefined && account.quota.remaining_usd <= 0) {
    return "quota_exhausted";
  }

  if (modelContextWindow !== undefined && requestedContextTokens > modelContextWindow) {
    return "context_window_exceeded";
  }

  if (hasTools && !endpoint.capabilities.tools) {
    return "tool_capability_not_supported";
  }

  if (requiresJson && !endpoint.capabilities.json_mode) {
    return "json_capability_not_supported";
  }

  return null;
}

export function selectRoute(
  config: RouterConfig,
  modelCatalog: ModelCatalog,
  _priceTable: PriceTable,
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
    throw new HttpError(400, "model_not_found", `Unknown route or model: ${routeId}`);
  }

  const candidates = resolvedTarget.candidates;
  if (candidates.length === 0) {
    if (resolvedTarget.mode === "provider_model") {
      throw new HttpError(
        400,
        "provider_model_not_found",
        `Unknown provider/model target: ${routeId}`
      );
    }

    throw new HttpError(400, "model_not_found", `Unknown route or model: ${routeId}`);
  }

  const evaluations: CandidateEvaluation[] = [];
  const filtered: CandidateEvaluation[] = [];
  const passed: Array<SelectedRoute & { score: number }> = [];
  const policy = config.policies[config.defaults.policy];
  const minTrustLevel = policy?.min_trust_level ?? "low";

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
      config,
      provider,
      endpoint,
      account,
      modelDefinition.context_window,
      hasTools,
      requiresJson,
      requestedContextTokens,
      privacyLevel,
      minTrustLevel
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

    const stickyScore =
      stickyRoute &&
      stickyRoute.routeId === candidate.routeId &&
      stickyRoute.platformId === platform.id &&
      stickyRoute.providerId === provider.id &&
      stickyRoute.endpointId === endpoint.id &&
      stickyRoute.accountId === account.id &&
      stickyRoute.modelId === candidate.modelId
        ? 10
        : 0;
    const quotaPressurePenalty =
      account.quota?.remaining_usd !== undefined && account.quota.remaining_usd < 1 ? 10 : 0;
    const recentErrorPenalty =
      endpoint.recent_error_count * 5 + account.recent_error_count * 5;
    const healthScore =
      endpoint.health === "healthy" ? 30 : endpoint.health === "degraded" ? 15 : 20;
    const score =
      healthScore +
      trustLevelScore(provider.trust_level) * 20 +
      stickyScore -
      quotaPressurePenalty -
      recentErrorPenalty;

    evaluations.push({
      routeId: candidate.routeId,
      platform: platform.id,
      provider: provider.id,
      endpoint: endpoint.id,
      account: candidate.account,
      modelId: candidate.modelId,
      model: candidate.model,
      score,
      sticky: stickyScore > 0
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
    throw new HttpError(503, "endpoint_unavailable", "No eligible route candidate");
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
