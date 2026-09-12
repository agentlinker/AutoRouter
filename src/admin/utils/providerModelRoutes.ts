import type {
  ProviderAccount,
  ProviderDetails,
  ProviderModel
} from "../api/providers.js";
import {
  formatRouteStatusDetail,
  isRuntimeStatusSchedulable,
  runtimeObservationDisplayLabel,
  runtimeStatusDetail,
  runtimeStatusDisplayLabel
} from "../runtimeStatusPresentation.js";

export type ModelRouteState = "available" | "partial" | "unavailable";
export type ModelConnectivityState = "available" | "pending" | "unavailable";

type EndpointRouteState = "available" | "unknown" | "unavailable";
type AccountEndpointModelObservation = ProviderDetails["account_endpoint_models"][number];

export function endpointProtocolLabel(protocol: string) {
  switch (protocol) {
    case "openai-responses":
      return "OpenAI Responses";
    case "openai-chat-completions":
      return "OpenAI Chat Completions";
    case "anthropic-messages":
      return "Anthropic Messages";
    default:
      return protocol;
  }
}

export function isAccountSchedulable(account: ProviderAccount) {
  if (!account.enabled) {
    return false;
  }
  // 到期时间只用于 Key 池内排序，不作为过滤条件；实际过滤以凭证不能使用为准。
  if (
    account.quota &&
    typeof account.quota.remaining_usd === "number" &&
    account.quota.remaining_usd <= 0
  ) {
    return false;
  }
  return isRuntimeStatusSchedulable(account);
}

export function isProviderModelAvailable(model: {
  enabled?: boolean;
  runtime_status?: string | null;
  status_reason?: string | null;
  status_cooldown_until?: string | null;
}) {
  return model.enabled !== false && isRuntimeStatusSchedulable(model);
}

export function modelRouteSummary(provider: ProviderDetails, model: ProviderModel): {
  availableAccounts: number;
  accounts: number;
  availableRoutes: number;
  combinations: number;
} {
  const accounts = provider.accounts ?? [];
  const accountModels = accounts.flatMap((account) => {
    const accountModel = account.models?.find((item) => item.model_key === model.model_key);
    return accountModel ? [{ account, accountModel }] : [];
  });
  const enabledEndpoints = provider.endpoints.filter((endpoint) => endpoint.enabled);
  const availableRoutes = accountModels.flatMap(({ account }) =>
    enabledEndpoints.map((endpoint) => modelConnectivityStatus(provider, model, account, endpoint))
  ).filter((status) => status.state === "available").length;
  return {
    availableAccounts:
      provider.enabled && isProviderModelAvailable(model)
        ? accountModels.filter(({ account, accountModel }) =>
            isAccountSchedulable(account) && isProviderModelAvailable(accountModel)
          ).length
        : 0,
    accounts: accounts.length,
    availableRoutes,
    combinations: accountModels.length * enabledEndpoints.length
  };
}

function routeUnavailableReason(
  provider: ProviderDetails,
  model: ProviderModel,
  account: ProviderAccount
): string | null {
  if (!provider.enabled) {
    return "Provider 已停用";
  }
  if (!isAccountSchedulable(account)) {
    return runtimeStatusDetail(account) || "Key 不可调度";
  }
  if (!isProviderModelAvailable(model)) {
    return runtimeStatusDetail(model) || "模型不可用";
  }
  const accountModel = account.models?.find((item) => item.model_key === model.model_key);
  if (!accountModel) {
    return "该 Key 不可见此模型";
  }
  if (!isProviderModelAvailable(accountModel)) {
    return runtimeStatusDetail(accountModel) || "该 Key 的模型不可调度";
  }
  return null;
}

function findObservation(
  provider: ProviderDetails,
  account: ProviderAccount,
  model: ProviderModel,
  endpointKey: string
): AccountEndpointModelObservation | undefined {
  return provider.account_endpoint_models.find((item) =>
    item.account_key === account.account_key &&
    item.endpoint_key === endpointKey &&
    item.model_key === model.model_key
  );
}

function findAccountEndpoint(
  provider: ProviderDetails,
  account: ProviderAccount,
  endpointKey: string
) {
  return provider.account_endpoints.find((item) =>
    item.account_key === account.account_key && item.endpoint_key === endpointKey
  );
}

export function modelConnectivityStatus(
  provider: ProviderDetails,
  model: ProviderModel,
  account: ProviderAccount,
  endpoint: ProviderDetails["endpoints"][number]
): { state: ModelConnectivityState; label: string } {
  const unavailableReason = routeUnavailableReason(provider, model, account);
  if (unavailableReason) {
    return { state: "unavailable", label: unavailableReason };
  }
  if (!endpoint.enabled) {
    return { state: "unavailable", label: "Endpoint 已停用" };
  }
  if (!isRuntimeStatusSchedulable(endpoint)) {
    return { state: "unavailable", label: runtimeStatusDisplayLabel(endpoint) };
  }
  const relation = findAccountEndpoint(provider, account, endpoint.endpoint_key);
  if (relation && !relation.enabled) {
    return { state: "unavailable", label: "账号协议已停用" };
  }
  if (relation && !isRuntimeStatusSchedulable(relation)) {
    return { state: "unavailable", label: runtimeStatusDisplayLabel(relation) };
  }
  const observation = findObservation(provider, account, model, endpoint.endpoint_key);
  if (!observation) {
    return { state: "pending", label: "未验证（可尝试）" };
  }
  if (!isRuntimeStatusSchedulable(observation)) {
    return { state: "unavailable", label: runtimeObservationDisplayLabel(observation) };
  }
  return observation.last_success_at
    ? { state: "available", label: "可用" }
    : { state: "pending", label: runtimeObservationDisplayLabel(observation) };
}

function endpointRouteDetail(
  endpoint: ProviderDetails["endpoints"][number],
  observation: AccountEndpointModelObservation | undefined,
  label: string,
  accountKey?: string
): string {
  const detail = observation
    ? runtimeStatusDetail(observation)
    : runtimeStatusDetail(endpoint);
  const routeLabel = [
    accountKey,
    endpointProtocolLabel(endpoint.protocol)
  ].filter(Boolean).join(" · ");
  return formatRouteStatusDetail(routeLabel, label, detail);
}

export function modelRouteStatus(
  provider: ProviderDetails,
  model: ProviderModel,
  account?: ProviderAccount
): { state: ModelRouteState; tooltip: string } {
  const accounts = account
    ? [account]
    : (provider.accounts ?? []).filter((item) =>
        item.models?.some((accountModel) => accountModel.model_key === model.model_key)
      );
  const endpoints = provider.endpoints.filter((endpoint) => endpoint.enabled);
  const endpointStatuses = accounts.flatMap((routeAccount) => {
    return endpoints.map((endpoint) => {
      const observation = findObservation(provider, routeAccount, model, endpoint.endpoint_key);
      const connectivity = modelConnectivityStatus(provider, model, routeAccount, endpoint);
      const state: EndpointRouteState = connectivity.state === "pending"
        ? "unknown"
        : connectivity.state;
      return {
        state,
        detail: endpointRouteDetail(
          endpoint,
          observation,
          connectivity.label,
          account ? undefined : routeAccount.account_key
        )
      };
    });
  });
  const availableCount = endpointStatuses.filter((item) => item.state === "available").length;
  const hasUnknown = endpointStatuses.some((item) => item.state === "unknown");
  const state: ModelRouteState =
    availableCount === endpointStatuses.length && endpointStatuses.length > 0
      ? "available"
      : availableCount > 0 || hasUnknown
        ? "partial"
        : "unavailable";
  return {
    state,
    tooltip: [
      `路由状态: ${state === "available" ? "可用" : state === "partial" ? "部分可用/待验证" : "不可用"}`,
      ...endpointStatuses.map((item) => item.detail)
    ].join("\n")
  };
}
