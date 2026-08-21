export interface RuntimeStatusInput {
  runtime_status?: string | null;
  status_reason?: string | null;
  status_message?: string | null;
  status_cooldown_until?: string | null;
}

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
  if (isRuntimeNormal(input.runtime_status)) {
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
  return isRuntimeStatusSchedulable(input) && !isRuntimeNormal(input.runtime_status)
    ? "可调度"
    : runtimeStatusLabel(input.runtime_status);
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
