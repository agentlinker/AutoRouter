import type { ModelCatalog } from "../catalog/modelCatalog.js";
import type { PriceTable } from "../catalog/priceTable.js";
import type { RouterConfig } from "../config/schema.js";
import type {
  AccountRuntimeState,
  EndpointRuntimeState,
  PlatformRuntimeState
} from "../state/routerState.js";
import { HttpError } from "../utils/httpErrors.js";
import type { StickyRoute } from "./stickySession.js";

export interface SelectedRoute {
  platform: PlatformRuntimeState;
  endpoint: EndpointRuntimeState;
  account: AccountRuntimeState;
  model: string;
  candidateIndex: number;
}

export interface CandidateEvaluation {
  endpoint: string;
  platform: string;
  account: string;
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

function canUseProvider(
  config: RouterConfig,
  platform: PlatformRuntimeState,
  endpoint: EndpointRuntimeState,
  account: AccountRuntimeState,
  candidateModel: string,
  hasTools: boolean,
  requiresJson: boolean,
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
    platform.privacy_level === "public_only" &&
    !config.policies[config.defaults.policy]?.allow_public_only_provider
  ) {
    return "privacy_level_not_allowed";
  }

  if (
    (minTrustLevel === "high" && platform.trust_level !== "high") ||
    (minTrustLevel === "medium" && platform.trust_level === "low")
  ) {
    return "trust_level_not_allowed";
  }

  if (account.quota?.remaining_usd !== undefined && account.quota.remaining_usd <= 0) {
    return "quota_exhausted";
  }

  if (hasTools && candidateModel.includes("deepseek")) {
    return "tool_capability_not_supported";
  }

  if (requiresJson && candidateModel.includes("ollama")) {
    return "json_capability_not_supported";
  }

  return null;
}

export function selectRoute(
  config: RouterConfig,
  modelCatalog: ModelCatalog,
  _priceTable: PriceTable,
  platforms: PlatformRuntimeState[],
  endpoints: EndpointRuntimeState[],
  accounts: AccountRuntimeState[],
  modelId: string,
  hasTools: boolean,
  requiresJson: boolean,
  privacyLevel: string,
  stickyRoute?: StickyRoute | null
): {
  selected: SelectedRoute;
  candidates: CandidateEvaluation[];
  filtered: CandidateEvaluation[];
} {
  const candidates = modelCatalog.getCandidates(modelId);
  if (candidates.length === 0) {
    throw new HttpError(400, "model_not_found", `Unknown model or alias: ${modelId}`);
  }

  const evaluations: CandidateEvaluation[] = [];
  const filtered: CandidateEvaluation[] = [];
  const passed: Array<SelectedRoute & { score: number }> = [];
  const policy = config.policies[config.defaults.policy];
  const minTrustLevel = policy?.min_trust_level ?? "low";

  for (const [index, candidate] of candidates.entries()) {
    const endpoint = endpoints.find((item) => item.id === candidate.endpoint);
    const platform = endpoint
      ? platforms.find((item) => item.id === endpoint.platform_id)
      : undefined;
    const account = accounts.find(
      (item) => item.endpoint_id === candidate.endpoint && item.id === candidate.account
    );

    if (!endpoint || !platform || !account) {
      filtered.push({
        endpoint: candidate.endpoint,
        platform: endpoint?.platform_id ?? "unknown",
        account: candidate.account,
        model: candidate.model,
        filteredReason: "candidate_not_found"
      });
      continue;
    }

    const filteredReason = canUseProvider(
      config,
      platform,
      endpoint,
      account,
      candidate.model,
      hasTools,
      requiresJson,
      privacyLevel,
      minTrustLevel
    );
    if (filteredReason) {
      filtered.push({
        endpoint: candidate.endpoint,
        platform: platform.id,
        account: candidate.account,
        model: candidate.model,
        filteredReason
      });
      continue;
    }

    const stickyScore =
      stickyRoute &&
      stickyRoute.endpointId === endpoint.id &&
      stickyRoute.accountId === account.id &&
      stickyRoute.model === candidate.model
        ? 10
        : 0;
    const quotaPressurePenalty =
      account.quota?.remaining_usd !== undefined && account.quota.remaining_usd < 1 ? 10 : 0;
    const recentErrorPenalty =
      endpoint.recent_error_count * 5 + account.recent_error_count * 5;
    const healthScore = endpoint.health === "healthy" ? 30 : endpoint.health === "degraded" ? 15 : 20;
    const score =
      healthScore +
      trustLevelScore(platform.trust_level) * 20 +
      stickyScore -
      quotaPressurePenalty -
      recentErrorPenalty;

    const evaluation = {
      endpoint: candidate.endpoint,
      platform: platform.id,
      account: candidate.account,
      model: candidate.model,
      score,
      sticky: stickyScore > 0
    };
    evaluations.push(evaluation);
    passed.push({
      platform,
      endpoint,
      account,
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
    candidates: evaluations,
    filtered
  };
}
