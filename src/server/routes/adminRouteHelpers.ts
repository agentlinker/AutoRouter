import type { RouterConfig } from "../../config/schema.js";
import type { ManagedProviderRepository } from "../../repositories/managedProviderRepository.js";
import type { RuntimeSnapshot } from "../../runtime/runtimeTypes.js";
import type { RouteTrace, TraceCandidate } from "../../trace/traceTypes.js";

export function formatConfigValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }

  return JSON.stringify(value, null, 2);
}

function serializeCandidate(candidate: TraceCandidate) {
  return {
    route_id: candidate.route_id ?? null,
    endpoint: candidate.endpoint,
    platform: candidate.platform,
    provider: candidate.provider ?? null,
    account: candidate.account,
    model_id: candidate.model_id ?? null,
    model: candidate.model,
    reason: candidate.reason ?? null,
    score: candidate.score ?? null,
    sticky: candidate.sticky ?? false
  };
}

export function serializeTrace(trace: RouteTrace) {
  const inputTokens = trace.execution.input_tokens ?? 0;
  const outputTokens = trace.execution.output_tokens ?? 0;
  const totalTokens = trace.execution.total_tokens ?? inputTokens + outputTokens;

  return {
    trace_id: trace.trace_id,
    timestamp: trace.timestamp,
    session_id: trace.session_id,
    requested_model: trace.request.model,
    normalized_model: trace.request.normalized_model,
    stream: trace.request.stream,
    has_tools: trace.request.has_tools,
    privacy_level: trace.request.privacy_level,
    context_tokens_est: trace.request.context_tokens_est,
    selected_provider: trace.selected?.provider ?? null,
    selected_endpoint: trace.selected?.endpoint ?? null,
    selected_route_id: trace.selected?.route_id ?? null,
    selected_model: trace.selected?.model ?? null,
    selected_score: trace.selected?.score ?? null,
    status: trace.execution.status,
    latency_ms: trace.execution.latency_ms,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    estimated_cost_usd: trace.cost.estimated_usd,
    actual_cost_usd: trace.cost.actual_usd,
    price_confidence: trace.cost.price_confidence,
    policy_hits: trace.policy_hits,
    error: trace.execution.error ?? null,
    candidate_count: trace.candidates.length,
    filtered_count: trace.filtered.length,
    fallback_count: trace.fallbacks.length,
    feedback: trace.feedback ?? null,
    candidates: trace.candidates.map(serializeCandidate),
    filtered: trace.filtered.map(serializeCandidate),
    fallbacks: trace.fallbacks.map(serializeCandidate)
  };
}

export function listApiKeys(
  repository: ManagedProviderRepository,
  config: RouterConfig
) {
  const providerDetails = repository.listProviderSummaries();

  return {
    system: [
      {
        scope: "system" as const,
        entry_id: "gateway-token",
        label: "Gateway Token",
        description: "用于访问 `/v1/*` 网关接口。",
        env_name: config.server.gateway_token_env,
        configured: Boolean(process.env[config.server.gateway_token_env])
      },
      {
        scope: "system" as const,
        entry_id: "admin-token",
        label: "Admin Token",
        description: "用于访问 `/admin/api/*` 管理接口。",
        env_name: config.server.admin_token_env,
        configured: Boolean(process.env[config.server.admin_token_env])
      }
    ],
    providers: providerDetails.map((details) => ({
      scope: "provider" as const,
      entry_id: details.provider.providerKey,
      provider_key: details.provider.providerKey,
      display_name: details.provider.displayName,
      enabled: details.provider.enabled,
      key_hint: details.credential?.keyHint ?? null,
      configured: Boolean(details.credential?.apiKeyEncrypted),
      updated_at: details.credential?.updatedAt ?? null
    }))
  };
}

export function getApiKeyDetail(
  repository: ManagedProviderRepository,
  config: RouterConfig,
  keyScope: string,
  entryId: string
) {
  const apiKeys = listApiKeys(repository, config);

  if (keyScope === "system") {
    return apiKeys.system.find((item) => item.entry_id === entryId) ?? null;
  }

  if (keyScope === "provider") {
    return apiKeys.providers.find((item) => item.entry_id === entryId) ?? null;
  }

  return null;
}

export function listPolicies(config: RouterConfig) {
  return Object.entries(config.policies).map(([policyId, policyConfig]) => {
    const boundRoutes = Object.entries(config.routes)
      .filter(([, routeConfig]) => routeConfig.policy === policyId)
      .map(([routeId]) => routeId);

    return {
      policy_id: policyId,
      is_default: config.defaults.policy === policyId,
      route_count: boundRoutes.length,
      routes: boundRoutes,
      min_trust_level: policyConfig.min_trust_level,
      allow_public_only_provider: policyConfig.allow_public_only_provider,
      fallback_enabled: policyConfig.fallback_enabled,
      sticky_session: policyConfig.sticky_session,
      thresholds: policyConfig.thresholds,
      weights: policyConfig.weights
    };
  });
}

export function getPolicyDetail(config: RouterConfig, policyId: string) {
  return listPolicies(config).find((item) => item.policy_id === policyId) ?? null;
}

export function buildSettingsSections(config: RouterConfig, snapshot: RuntimeSnapshot) {
  return [
    {
      section_id: "server",
      label: "Server",
      description: "网关监听地址、端口与认证环境变量。",
      items: [
        { key: "host", label: "Host", value: formatConfigValue(config.server.host) },
        { key: "port", label: "Port", value: formatConfigValue(config.server.port) },
        {
          key: "request_timeout_ms",
          label: "Request Timeout",
          value: formatConfigValue(config.server.request_timeout_ms)
        },
        {
          key: "gateway_token_env",
          label: "Gateway Token Env",
          value: formatConfigValue(config.server.gateway_token_env)
        },
        {
          key: "admin_token_env",
          label: "Admin Token Env",
          value: formatConfigValue(config.server.admin_token_env)
        }
      ]
    },
    {
      section_id: "defaults",
      label: "Defaults",
      description: "默认模型、策略与隐私等级。",
      items: [
        { key: "model", label: "Default Model", value: formatConfigValue(config.defaults.model) },
        {
          key: "policy",
          label: "Default Policy",
          value: formatConfigValue(config.defaults.policy)
        },
        {
          key: "privacy_level",
          label: "Default Privacy",
          value: formatConfigValue(config.defaults.privacy_level)
        }
      ]
    },
    {
      section_id: "storage",
      label: "Storage",
      description: "数据库位置与运行时持久化状态。",
      items: [
        { key: "database.path", label: "SQLite Path", value: formatConfigValue(config.database.path) },
        { key: "trace.log_prompts", label: "Log Prompts", value: formatConfigValue(config.trace.log_prompts) }
      ]
    },
    {
      section_id: "runtime",
      label: "Runtime",
      description: "当前运行态加载出的平台、端点、账号与模型数量。",
      items: [
        { key: "platforms", label: "Platforms", value: formatConfigValue(snapshot.platforms.length) },
        { key: "providers", label: "Providers", value: formatConfigValue(snapshot.providers.length) },
        { key: "endpoints", label: "Endpoints", value: formatConfigValue(snapshot.endpoints.length) },
        { key: "accounts", label: "Accounts", value: formatConfigValue(snapshot.accounts.length) },
        {
          key: "models",
          label: "Runtime Models",
          value: formatConfigValue(Object.keys(snapshot.config.models).length)
        },
        { key: "routes", label: "Routes", value: formatConfigValue(Object.keys(snapshot.config.routes).length) }
      ]
    }
  ];
}

export function getSettingsSection(snapshot: RuntimeSnapshot, sectionId: string) {
  return buildSettingsSections(snapshot.config, snapshot).find((item) => item.section_id === sectionId) ?? null;
}
