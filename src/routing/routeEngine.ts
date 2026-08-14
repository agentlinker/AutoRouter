import type { ModelCatalog } from "../catalog/modelCatalog.js";
import type { PriceTable } from "../catalog/priceTable.js";
import type {
  ModelDefinitionConfig,
  PolicyConfig,
  PolicyThresholdsConfig,
  PolicyWeightsConfig,
  RouterConfig
} from "../config/schema.js";
import type {
  AccountRuntimeState,
  EndpointRuntimeState,
  ModelRuntimeStatusState,
  PlatformRuntimeState,
  ProviderRuntimeState
} from "../state/routerState.js";
import { accountModelStatusKey } from "../state/routerState.js";
import { HttpError } from "../utils/httpErrors.js";
import { modelFilterReason, resolveAccountExecutionGate } from "../runtime/runtimeStatus.js";
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
  /** 上游模型名（provider model id / model_name） */
  model: string;
  /** 目录里解析出的完整模型定义，调用方执行时需要它构造 RouteTarget */
  modelDefinition: ModelDefinitionConfig;
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

export function compareRouteCandidateOrder(
  left: {
    provider: Pick<ProviderRuntimeState, "priority">;
    score: number;
    candidateIndex: number;
  },
  right: {
    provider: Pick<ProviderRuntimeState, "priority">;
    score: number;
    candidateIndex: number;
  }
): number {
  const priorityDelta = (right.provider.priority ?? 0) - (left.provider.priority ?? 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  return left.candidateIndex - right.candidateIndex;
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
  privacyLevel: string,
  modelStatus?: ModelRuntimeStatusState | null,
  requestedContextWindow?: number
): string | null {
  if (modelStatus) {
    const modelReason = modelFilterReason({
      enabled: true,
      runtimeStatus: modelStatus.runtime_status,
      statusReason: modelStatus.status_reason,
      statusMessage: modelStatus.status_message,
      statusCooldownUntil: modelStatus.status_cooldown_until
    });
    if (modelReason) {
      return modelReason;
    }
  }

  if (!endpoint.enabled) {
    return "endpoint_disabled";
  }

  if (endpoint.health === "down") {
    return "endpoint_down";
  }

  const accountGate = resolveAccountExecutionGate({
    enabled: account.enabled,
    available: account.available,
    runtimeStatus: account.runtime_status ?? "normal",
    statusReason: account.status_reason,
    statusMessage: account.status_message,
    statusCooldownUntil: account.status_cooldown_until,
    disabledReason: account.disabled_reason,
    disabledMessage: account.disabled_message
  });
  if (!accountGate.canExecute) {
    return accountGate.message ?? accountGate.reason ?? "account_unavailable";
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

  // 调用方通过 selector 后缀（如 `[1m]`）显式要求的窗口：只过滤明确小于要求的候选。
  // 元数据缺失（undefined）时放过，由 policy_hits 的 context_window_unknown 观测。
  if (
    requestedContextWindow !== undefined &&
    modelContextWindow !== undefined &&
    modelContextWindow < requestedContextWindow
  ) {
    return "requested_context_window_not_supported";
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

/**
 * 入站协议与上游 endpoint 协议一致时的加分。
 *
 * 目的是让 `/v1/messages` 优先命中 anthropic endpoint（零转换透传），
 * 同时保持「偏好」而非硬过滤：没有同协议 endpoint 时仍可用转换路径，
 * 同协议 endpoint 熔断时仍能 fallback。取值需明显大于常规打分区间
 * （各项权重之和量级为 1）才能稳定压过成本/健康分的差异。
 */
const PROTOCOL_MATCH_BONUS = 50;

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
  priceTable: PriceTable,
  /** 候选 endpoint 所属 platform 的协议（protocol 定义在 platform 上） */
  candidateProtocol?: string,
  preferredProtocol?: string
): { score: number; sticky: boolean; protocolMatch: boolean } {
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

  const protocolMatch =
    preferredProtocol !== undefined &&
    candidateProtocol !== undefined &&
    candidateProtocol === preferredProtocol;

  const score =
    weights.health * healthScore +
    weights.trust * trustScore +
    weights.cost * costScore +
    weights.quality * qualityScore +
    weights.context * contextScore +
    weights.tools * toolsScore +
    weights.sticky * stickyScore -
    weights.error_penalty * recentErrorPenalty -
    weights.quota_penalty * quotaPressurePenalty +
    (protocolMatch ? PROTOCOL_MATCH_BONUS : 0);

  return {
    score,
    sticky,
    protocolMatch
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
  stickyRoute?: StickyRoute | null,
  modelStatuses: Record<string, ModelRuntimeStatusState> = {},
  /**
   * 入站协议偏好：与候选 endpoint 协议一致时加分，让同协议候选优先被选中
   * （零转换透传）。不做硬过滤，没有同协议候选时仍走转换路径。
   */
  preferredProtocol?: string
): {
  selected: SelectedRoute;
  /**
   * 已按 provider priority → score → candidateIndex 排好序的完整候选列表，
   * 字段是 runtime 对象引用。调用方直接按此顺序做 fallback，无需再排序或反查。
   */
  ordered: Array<SelectedRoute & { score: number; sticky: boolean }>;
  requestedModel: string;
  normalizedModel: string;
  candidates: CandidateEvaluation[];
  filtered: CandidateEvaluation[];
  /** selector 后缀显式要求的上下文窗口，无后缀时为 undefined */
  requestedContextWindow?: number;
  /** 命中候选中存在元数据缺失（context_window 未知）的情况，供 policy_hits 观测 */
  contextWindowUnknown: boolean;
  /**
   * 是否存在与入站协议一致的候选。false 表示只能走协议转换路径，
   * 供 policy_hits 打 protocol_mismatch 观测。
   */
  sawProtocolMatch: boolean;
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
  const passed: Array<SelectedRoute & { score: number; sticky: boolean }> = [];
  let contextWindowUnknown = false;
  let sawProtocolMatch = false;
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

    const modelStatus =
      modelStatuses[accountModelStatusKey(account.id, candidate.modelId)] ??
      modelStatuses[accountModelStatusKey(account.id, candidate.model)] ??
      modelStatuses[candidate.modelId] ??
      modelStatuses[`${provider.id}|${candidate.modelId}`] ??
      modelStatuses[`${provider.id}|${candidate.model}`] ??
      null;

    const filteredReason = canUseCandidate(
      thresholds,
      provider,
      endpoint,
      account,
      modelDefinition.context_window,
      hasTools,
      requiresJson,
      requestedContextTokens,
      privacyLevel,
      modelStatus,
      resolvedTarget.requestedContextWindow
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

    const { score, sticky, protocolMatch } = evaluateCandidateScore(
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
      priceTable,
      platform.protocol,
      preferredProtocol
    );

    if (protocolMatch) {
      sawProtocolMatch = true;
    }

    // 显式要求了窗口，但候选元数据缺失：放过但记下来，供 policy_hits 观测。
    if (
      resolvedTarget.requestedContextWindow !== undefined &&
      modelDefinition.context_window === undefined
    ) {
      contextWindowUnknown = true;
    }

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
      modelDefinition,
      candidateIndex: index,
      score,
      sticky
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

  passed.sort(compareRouteCandidateOrder);

  return {
    selected: passed[0],
    ordered: passed,
    requestedModel: resolvedTarget.requested,
    normalizedModel: resolvedTarget.normalized,
    candidates: evaluations,
    filtered,
    requestedContextWindow: resolvedTarget.requestedContextWindow,
    contextWindowUnknown,
    sawProtocolMatch
  };
}
