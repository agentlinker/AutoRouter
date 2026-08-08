/**
 * 运行态状态机：
 * - normal        可调度
 * - rate_limited  429 冷却，走 rate_limit_backoff_seconds 阶梯
 * - cooling_down  非限流错误冷却（上游 5xx / 节点不可达 / 模型下线），到期自动恢复
 * - abnormal      永久熔断，仅人工 enable 可恢复
 * - disabled      鉴权 / 账单失败，仅人工 enable 可恢复
 */
export type RuntimeStatus = "normal" | "disabled" | "rate_limited" | "cooling_down" | "abnormal";

export interface RuntimeStatusSettings {
  /** model 累计错误达到该值 → 永久 abnormal（account 冷却反复救不回来时的兜底归因） */
  error_threshold: number;
  /** 429 冷却阶梯 */
  rate_limit_backoff_seconds: number[];
  /** 上游 5xx / 超时 / 不可达 的 account 级冷却阶梯 */
  error_backoff_seconds: number[];
  /** 404 / 410 的 model 级冷却阶梯 */
  model_unavailable_backoff_seconds: number[];
  /** 429 走完阶梯后是否转永久 */
  permanent_after_final_backoff: boolean;
  /** 错误冷却走完阶梯后是否把 account 转永久 abnormal；false 时循环使用最后一档 */
  error_permanent_after_final_backoff: boolean;
  clear_counters_on_success: boolean;
  auth_disables_provider: boolean;
}

export const DEFAULT_RUNTIME_STATUS_SETTINGS: RuntimeStatusSettings = {
  error_threshold: 10,
  rate_limit_backoff_seconds: [30, 60, 120, 300, 600, 3600, 86400],
  error_backoff_seconds: [15, 30, 60, 300, 900, 3600],
  model_unavailable_backoff_seconds: [1800, 21600, 86400],
  permanent_after_final_backoff: true,
  error_permanent_after_final_backoff: false,
  clear_counters_on_success: true,
  auth_disables_provider: true
};

export const RUNTIME_STATUS_SETTINGS_KEY = "runtime_status";

function normalizeLadder(input: unknown, fallback: number[]): number[] {
  const ladder = Array.isArray(input)
    ? input.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0
      )
    : [];

  return ladder.length > 0 ? ladder : fallback;
}

export function normalizeRuntimeStatusSettings(
  input: Partial<RuntimeStatusSettings> | null | undefined
): RuntimeStatusSettings {
  const threshold =
    typeof input?.error_threshold === "number" &&
    Number.isFinite(input.error_threshold) &&
    input.error_threshold >= 1
      ? Math.floor(input.error_threshold)
      : DEFAULT_RUNTIME_STATUS_SETTINGS.error_threshold;

  return {
    error_threshold: threshold,
    rate_limit_backoff_seconds: normalizeLadder(
      input?.rate_limit_backoff_seconds,
      DEFAULT_RUNTIME_STATUS_SETTINGS.rate_limit_backoff_seconds
    ),
    error_backoff_seconds: normalizeLadder(
      input?.error_backoff_seconds,
      DEFAULT_RUNTIME_STATUS_SETTINGS.error_backoff_seconds
    ),
    model_unavailable_backoff_seconds: normalizeLadder(
      input?.model_unavailable_backoff_seconds,
      DEFAULT_RUNTIME_STATUS_SETTINGS.model_unavailable_backoff_seconds
    ),
    permanent_after_final_backoff:
      input?.permanent_after_final_backoff ??
      DEFAULT_RUNTIME_STATUS_SETTINGS.permanent_after_final_backoff,
    error_permanent_after_final_backoff:
      input?.error_permanent_after_final_backoff ??
      DEFAULT_RUNTIME_STATUS_SETTINGS.error_permanent_after_final_backoff,
    clear_counters_on_success:
      input?.clear_counters_on_success ?? DEFAULT_RUNTIME_STATUS_SETTINGS.clear_counters_on_success,
    auth_disables_provider:
      input?.auth_disables_provider ?? DEFAULT_RUNTIME_STATUS_SETTINGS.auth_disables_provider
  };
}

export function isRuntimeStatusValue(value: unknown): value is RuntimeStatus {
  return (
    value === "normal" ||
    value === "disabled" ||
    value === "rate_limited" ||
    value === "cooling_down" ||
    value === "abnormal"
  );
}

export interface CooldownDecision {
  /** 落库的 strike，最多到 ladder.length + 1 */
  strike: number;
  /** null 表示没有冷却终点（永久） */
  seconds: number | null;
  permanent: boolean;
  cooldownUntil: string | null;
}

/**
 * 按阶梯推进一次冷却。走完阶梯后：permanentAfterFinal 为真则转永久，
 * 否则循环使用最后一档（而不是变成"立刻可重试"）。
 */
export function nextCooldown(input: {
  previousStrike: number;
  ladder: number[];
  permanentAfterFinal: boolean;
  now?: Date;
}): CooldownDecision {
  const ladder = input.ladder;
  const previousStrike = Number.isFinite(input.previousStrike)
    ? Math.max(0, Math.floor(input.previousStrike))
    : 0;
  const nextStrike = previousStrike + 1;
  const strike = Math.min(nextStrike, ladder.length + 1);

  if (ladder.length === 0) {
    return { strike, seconds: null, permanent: input.permanentAfterFinal, cooldownUntil: null };
  }

  const beyondLadder = nextStrike > ladder.length;
  if (beyondLadder && input.permanentAfterFinal) {
    return { strike, seconds: null, permanent: true, cooldownUntil: null };
  }

  const seconds = beyondLadder ? ladder[ladder.length - 1]! : ladder[nextStrike - 1]!;
  const base = input.now ?? new Date();

  return {
    strike,
    seconds,
    permanent: false,
    cooldownUntil: new Date(base.getTime() + seconds * 1000).toISOString()
  };
}

export function isCooldownActive(cooldownUntil: string | null | undefined, now = new Date()): boolean {
  if (!cooldownUntil) {
    return false;
  }
  const ts = Date.parse(cooldownUntil);
  if (!Number.isFinite(ts)) {
    return false;
  }
  return ts > now.getTime();
}

/** cooling_down 是否仍在冷却期内（reason 带 _permanent 表示无终点） */
function isCoolingDownBlocked(input: {
  statusReason?: string | null;
  statusCooldownUntil?: string | null;
  now?: Date;
}): boolean {
  if (input.statusReason?.endsWith("_permanent")) {
    return true;
  }
  return isCooldownActive(input.statusCooldownUntil, input.now);
}

export function isProviderSchedulable(input: {
  enabled: boolean;
  runtimeStatus: RuntimeStatus;
  statusReason?: string | null;
  statusMessage?: string | null;
  statusCooldownUntil?: string | null;
  now?: Date;
}): boolean {
  // 与 routeEngine 共用同一套判定，避免两处对冷却态的理解漂移
  return providerFilterReason(input) === null;
}

export function providerFilterReason(input: {
  enabled: boolean;
  runtimeStatus: RuntimeStatus;
  statusReason?: string | null;
  statusMessage?: string | null;
  statusCooldownUntil?: string | null;
  now?: Date;
}): string | null {
  if (!input.enabled) {
    return "provider_disabled";
  }
  if (input.runtimeStatus === "disabled") {
    return input.statusMessage ?? input.statusReason ?? "provider_auth_failed";
  }
  if (input.runtimeStatus === "abnormal") {
    return input.statusMessage ?? input.statusReason ?? "provider_abnormal";
  }
  if (input.runtimeStatus === "cooling_down") {
    if (isCoolingDownBlocked(input)) {
      return (
        input.statusMessage ??
        input.statusReason ??
        `provider_cooling_down:${input.statusCooldownUntil}`
      );
    }
    // 冷却到期 — 放行重试
    return null;
  }
  // provider-level rate_limited rarely used; treat like model
  if (input.runtimeStatus === "rate_limited") {
    if (
      input.statusReason === "rate_limited_permanent" ||
      isCooldownActive(input.statusCooldownUntil, input.now)
    ) {
      return input.statusMessage ?? input.statusReason ?? "provider_rate_limited";
    }
    return null;
  }
  return null;
}

export function modelFilterReason(input: {
  enabled: boolean;
  runtimeStatus: RuntimeStatus;
  statusReason?: string | null;
  statusMessage?: string | null;
  statusCooldownUntil?: string | null;
  now?: Date;
}): string | null {
  if (!input.enabled) {
    return "model_disabled";
  }
  if (input.runtimeStatus === "disabled") {
    return input.statusMessage ?? input.statusReason ?? "model_disabled";
  }
  if (input.runtimeStatus === "abnormal") {
    return input.statusMessage ?? input.statusReason ?? "model_abnormal";
  }
  if (input.runtimeStatus === "cooling_down") {
    if (isCoolingDownBlocked(input)) {
      return (
        input.statusMessage ??
        input.statusReason ??
        `model_cooling_down:${input.statusCooldownUntil}`
      );
    }
    // cooldown expired — allow try
    return null;
  }
  if (input.runtimeStatus === "rate_limited") {
    if (input.statusReason === "rate_limited_permanent") {
      return input.statusMessage ?? "rate_limited_permanent";
    }
    if (isCooldownActive(input.statusCooldownUntil, input.now)) {
      return input.statusMessage ?? `rate_limited_cooldown:${input.statusCooldownUntil}`;
    }
    // cooldown expired — allow try
    return null;
  }
  return null;
}

/**
 * account 因运行态被判定不可调度时的原因/文案；返回 null 表示可用。
 * projector 与 admin 侧共用，避免各自枚举状态时漏掉新态。
 */
export function accountUnavailableReason(input: {
  runtimeStatus: RuntimeStatus;
  statusReason?: string | null;
  statusMessage?: string | null;
  statusCooldownUntil?: string | null;
  now?: Date;
}): { reason: string; message: string } | null {
  if (input.runtimeStatus === "disabled") {
    return {
      reason: input.statusReason ?? "account_auth_failed",
      message: input.statusMessage ?? "Invalid API key"
    };
  }

  if (input.runtimeStatus === "abnormal") {
    return {
      reason: input.statusReason ?? "account_abnormal",
      message: input.statusMessage ?? "Account abnormal"
    };
  }

  if (input.runtimeStatus === "cooling_down") {
    if (!isCoolingDownBlocked(input)) {
      return null;
    }
    return {
      reason: input.statusReason ?? "account_cooling_down",
      message: input.statusMessage ?? "Account cooling down"
    };
  }

  if (input.runtimeStatus === "rate_limited") {
    if (
      input.statusReason !== "rate_limited_permanent" &&
      !isCooldownActive(input.statusCooldownUntil, input.now)
    ) {
      return null;
    }
    return {
      reason: input.statusReason ?? "account_rate_limited",
      message: input.statusMessage ?? "Account rate limited"
    };
  }

  return null;
}

export interface AccountExecutionGate {
  canExecute: boolean;
  reason?: string;
  message?: string;
  recoveredFromExpiredCooldown: boolean;
}

/**
 * 判断当前 snapshot 里的 account 是否可进入执行阶段。
 * 只恢复派生可用性语义，不改 DB；DB 状态由实际请求后的 success/failure 记录更新。
 */
export function resolveAccountExecutionGate(input: {
  enabled: boolean;
  available: boolean;
  runtimeStatus?: RuntimeStatus | null;
  statusReason?: string | null;
  statusMessage?: string | null;
  statusCooldownUntil?: string | null;
  disabledReason?: string | null;
  disabledMessage?: string | null;
  now?: Date;
}): AccountExecutionGate {
  if (!input.enabled) {
    return {
      canExecute: false,
      reason: "account_disabled",
      message: "Account disabled",
      recoveredFromExpiredCooldown: false
    };
  }

  const runtimeStatus = input.runtimeStatus ?? "normal";
  const unavailable = accountUnavailableReason({
    runtimeStatus,
    statusReason: input.statusReason,
    statusMessage: input.statusMessage,
    statusCooldownUntil: input.statusCooldownUntil,
    now: input.now
  });
  if (unavailable) {
    return {
      canExecute: false,
      reason: unavailable.reason,
      message: unavailable.message,
      recoveredFromExpiredCooldown: false
    };
  }

  const recoverableExpired = runtimeStatus === "cooling_down" || runtimeStatus === "rate_limited";
  if (!input.available && !recoverableExpired) {
    return {
      canExecute: false,
      reason: input.disabledReason ?? "account_unavailable",
      message: input.disabledMessage ?? input.disabledReason ?? "Account unavailable",
      recoveredFromExpiredCooldown: false
    };
  }

  return {
    canExecute: true,
    recoveredFromExpiredCooldown: !input.available && recoverableExpired
  };
}

export type FailureClass =
  | "auth"
  | "billing"
  | "rate_limit"
  | "model_unavailable"
  | "transient"
  | "client_error";

/** 从错误对象或 message 里尽力恢复上游状态码 */
function resolveStatusCode(error: object, message: string): number | undefined {
  const direct =
    "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
  if (direct !== undefined) {
    return direct;
  }

  // 适配器在部分分支只把状态码写进 message（"... failed with status 502"）
  const matched = /status (\d{3})\b/i.exec(message);
  if (!matched) {
    return undefined;
  }
  const parsed = Number.parseInt(matched[1]!, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 判定顺序刻意让 statusCode 优先于 code：适配器的流式分支对所有非 429 的
 * 4xx/5xx 都抛 code=provider_error（openaiCompatible.ts:160、:275），
 * 只看 code 会把 410 这类确定性下线误判成可重试的 transient。
 * 兜底为 transient —— 没有状态码的未知异常（undici SSE 断流等）本质是上游不稳。
 */
export function classifyProviderFailure(error: unknown): FailureClass {
  if (!error || typeof error !== "object") {
    return "transient";
  }

  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const message = error instanceof Error ? error.message : "";
  const statusCode = resolveStatusCode(error, message);

  if (code === "provider_auth_failed" || statusCode === 401 || statusCode === 403) {
    return "auth";
  }

  if (statusCode === 402) {
    return "billing";
  }

  if (code === "provider_rate_limited" || statusCode === 429 || /status 429\b/i.test(message)) {
    return "rate_limit";
  }

  if (code === "provider_invalid_model" || statusCode === 404 || statusCode === 410) {
    return "model_unavailable";
  }

  if (statusCode === 408 || (statusCode !== undefined && statusCode >= 500)) {
    return "transient";
  }

  if (
    code === "provider_unreachable" ||
    code === "provider_timeout" ||
    code === "provider_server_error"
  ) {
    return "transient";
  }

  if (statusCode !== undefined && statusCode >= 400) {
    return "client_error";
  }

  return "transient";
}

/** 该错误类别是否应当惩罚上游（client_error 只留痕，不影响调度） */
export function shouldPenalizeProvider(failureClass: FailureClass): boolean {
  return failureClass !== "client_error";
}
