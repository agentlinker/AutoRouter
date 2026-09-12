export interface RuntimeStatusInput {
  runtime_status?: string | null;
  status_reason?: string | null;
  status_message?: string | null;
  status_cooldown_until?: string | null;
}

/** 到期时间字段统一 tooltip，列表列头、创建表单和编辑表单使用同一文案 */
export const EXPIRY_TOOLTIP_TEXT =
  "到期时间越早，API Key 在池内的使用优先级越高。该时间仅用于排序，不作为过滤条件；实际过滤以 API Key 不能使用为准。不填表示不过期。";

export function runtimeStatusLabel(status?: string | null) {
  switch (status) {
    case "disabled":
      return "鉴权异常";
    case "rate_limited":
      return "限流中";
    case "cooling_down":
      return "错误冷却中";
    case "abnormal":
      return "失败过多";
    case "unknown":
      return "待验证（可尝试）";
    case "normal":
    case undefined:
    case null:
      return "正常";
    default:
      return status;
  }
}

export function isRuntimeNormal(status?: string | null) {
  return status === "normal" || !status;
}

export function isCooldownActive(cooldownUntil?: string | null) {
  if (!cooldownUntil) {
    return false;
  }
  const until = Date.parse(cooldownUntil);
  return Number.isFinite(until) && until > Date.now();
}

/**
 * Keep this aligned with backend runtimeStatus.ts:
 * disabled / abnormal require recovery; rate_limited / cooling_down can route
 * again after cooldown unless marked permanent.
 */
export function isRuntimeStatusSchedulable(input: RuntimeStatusInput) {
  if (isRuntimeNormal(input.runtime_status) || input.runtime_status === "unknown") {
    return true;
  }
  if (input.runtime_status === "disabled" || input.runtime_status === "abnormal") {
    return false;
  }
  if (input.runtime_status === "rate_limited" || input.runtime_status === "cooling_down") {
    if (input.status_reason?.endsWith("_permanent")) {
      return false;
    }
    return !isCooldownActive(input.status_cooldown_until);
  }
  return false;
}

export function isManualRecoveryRequired(input: RuntimeStatusInput) {
  return !isRuntimeStatusSchedulable(input) && (
    input.runtime_status === "disabled" ||
    input.runtime_status === "abnormal" ||
    input.status_reason?.endsWith("_permanent") === true
  );
}

export function runtimeStatusBadgeClass(input: RuntimeStatusInput) {
  return isRuntimeStatusSchedulable(input) ? "badge success" : "badge warning";
}

export function runtimeStatusDisplayLabel(input: RuntimeStatusInput) {
  if (input.runtime_status === "unknown") {
    return "待验证（可尝试）";
  }
  return isRuntimeStatusSchedulable(input) && !isRuntimeNormal(input.runtime_status)
    ? "可调度"
    : runtimeStatusLabel(input.runtime_status);
}

export function runtimeObservationDisplayLabel(
  input?: RuntimeStatusInput & { last_success_at?: string | null }
) {
  if (!input) {
    return "未知（可尝试）";
  }
  if (input.runtime_status === "unknown") {
    return "未验证（可尝试）";
  }
  if (isRuntimeNormal(input.runtime_status)) {
    return input.last_success_at ? "可用" : "未验证（可尝试）";
  }
  if (
    input.runtime_status === "cooling_down" ||
    input.runtime_status === "rate_limited"
  ) {
    return isRuntimeStatusSchedulable(input) ? "未验证（可尝试）" : "冷却中";
  }
  return "不可用";
}

export function runtimeObservationErrorMessage(input?: RuntimeStatusInput) {
  if (!input?.status_message) {
    return null;
  }
  const label = isRuntimeStatusSchedulable(input) && !isRuntimeNormal(input.runtime_status)
    ? "最近错误"
    : "错误信息";
  return `${label}：${input.status_message}`;
}

export function formatRouteStatusDetail(
  protocolLabel: string,
  label: string,
  detail: string
) {
  const [summary = label, ...labelDetails] = label.split("\n").filter(Boolean);
  const detailLines = detail.split("\n").filter(Boolean);
  return [
    `• ${protocolLabel}: ${summary}`,
    ...[...labelDetails, ...detailLines].map((line) => `  ◦ ${line}`)
  ].join("\n");
}

export function runtimeStatusDetail(input: RuntimeStatusInput) {
  const code = input.status_reason ? `异常码: ${input.status_reason}` : null;
  const message = input.status_message ? `错误信息: ${input.status_message}` : null;
  const cooldown = input.status_cooldown_until
    ? `冷却至: ${new Date(input.status_cooldown_until).toLocaleString()}`
    : null;
  const parts = [
    isRuntimeStatusSchedulable(input) && !isRuntimeNormal(input.runtime_status)
      ? "调度状态: 可调度，保留最近一次异常记录"
      : null,
    code,
    message,
    cooldown
  ].filter(Boolean);
  return parts.join("\n");
}

// ── 统一有效可用性投影 ──
// 区分三个问题：人工是否启用、当前是否允许尝试、是否已有成功证据。

/** Key 行有效可用性摘要状态 */
export type AccountAvailabilityState =
  | "disabled"       // 人工停用
  | "no_target"      // 无可见模型或无启用协议
  | "available"      // 所有目标组合已验证成功且无阻塞
  | "partial"        // 一部分已验证可用，其余待验证或阻塞
  | "pending"        // 没有已验证可用组合，但存在允许首次尝试的组合
  | "unavailable";   // 所有目标组合均被已知条件阻塞

export interface AccountAvailabilitySummary {
  state: AccountAvailabilityState;
  /** 用户可见的中文标签 */
  label: string;
  /** CSS badge class */
  badgeClass: string;
  /** 主要阻塞原因（state=unavailable 时） */
  primaryBlockReason?: string;
  /** 已验证可用组合数 */
  verifiedCount: number;
  /** 待验证组合数 */
  pendingCount: number;
  /** 受阻组合数 */
  blockedCount: number;
  /** 总目标组合数 */
  totalCount: number;
}

/**
 * 由组合明细投影 Key 行有效可用性摘要。
 * 统计集合为：Provider 启用 Endpoint × 该 Key 可见且人工允许的模型组合。
 */
export function projectAccountAvailability(
  combinations: Array<{
    /** 该组合是否因人工开关被关闭 */
    manuallyDisabled?: boolean;
    /** 该组合是否有有效成功证据且当前无阻塞 */
    verifiedAvailable?: boolean;
    /** 该组合当前是否允许首次尝试（无已知阻塞） */
    canAttempt?: boolean;
    /** 阻塞原因文案 */
    blockReason?: string;
  }>,
  options?: {
    /** Provider 或 Key 本身是否被人工停用 */
    accountEnabled?: boolean;
    providerEnabled?: boolean;
  }
): AccountAvailabilitySummary {
  if (options?.accountEnabled === false || options?.providerEnabled === false) {
    return {
      state: "disabled",
      label: "已停用",
      badgeClass: "badge",
      verifiedCount: 0,
      pendingCount: 0,
      blockedCount: 0,
      totalCount: combinations.length
    };
  }

  if (combinations.length === 0) {
    return {
      state: "no_target",
      label: "无可见模型/协议",
      badgeClass: "badge",
      verifiedCount: 0,
      pendingCount: 0,
      blockedCount: 0,
      totalCount: 0
    };
  }

  let verifiedCount = 0;
  let pendingCount = 0;
  let blockedCount = 0;
  let primaryBlockReason: string | undefined;

  for (const combo of combinations) {
    if (combo.manuallyDisabled) {
      blockedCount += 1;
      primaryBlockReason ??= combo.blockReason ?? "人工关闭";
      continue;
    }
    if (combo.verifiedAvailable) {
      verifiedCount += 1;
      continue;
    }
    if (combo.canAttempt) {
      pendingCount += 1;
      continue;
    }
    blockedCount += 1;
    primaryBlockReason ??= combo.blockReason ?? "未知阻塞";
  }

  if (verifiedCount === combinations.length) {
    return {
      state: "available",
      label: "可用",
      badgeClass: "badge success",
      verifiedCount,
      pendingCount,
      blockedCount,
      totalCount: combinations.length
    };
  }

  if (verifiedCount > 0) {
    return {
      state: "partial",
      label: "部分可用",
      badgeClass: "badge warning",
      verifiedCount,
      pendingCount,
      blockedCount,
      totalCount: combinations.length
    };
  }

  if (pendingCount > 0) {
    const blockedNote = blockedCount > 0 ? `，${blockedCount} 个组合受阻` : "";
    return {
      state: "pending",
      label: `待验证${blockedNote}`,
      badgeClass: "badge warning",
      verifiedCount,
      pendingCount,
      blockedCount,
      totalCount: combinations.length
    };
  }

  return {
    state: "unavailable",
    label: `不可用：${primaryBlockReason ?? "全部受阻"}`,
    badgeClass: "badge danger",
    primaryBlockReason,
    verifiedCount,
    pendingCount,
    blockedCount,
    totalCount: combinations.length
  };
}

/** Provider 摘要：聚合所有 Key 的可用性 */
export interface ProviderAvailabilitySummary {
  verifiedKeys: number;
  pendingKeys: number;
  unavailableKeys: number;
  totalKeys: number;
  /** 主要阻塞原因 */
  primaryBlockReason?: string;
}

export function projectProviderAvailability(
  accountSummaries: AccountAvailabilitySummary[]
): ProviderAvailabilitySummary {
  let verifiedKeys = 0;
  let pendingKeys = 0;
  let unavailableKeys = 0;
  let primaryBlockReason: string | undefined;

  for (const summary of accountSummaries) {
    if (summary.state === "disabled" || summary.state === "no_target") {
      continue;
    }
    if (summary.state === "available") {
      verifiedKeys += 1;
    } else if (summary.state === "partial" || summary.state === "pending") {
      pendingKeys += 1;
    } else {
      unavailableKeys += 1;
      primaryBlockReason ??= summary.primaryBlockReason;
    }
  }

  return {
    verifiedKeys,
    pendingKeys,
    unavailableKeys,
    totalKeys: verifiedKeys + pendingKeys + unavailableKeys,
    primaryBlockReason
  };
}
