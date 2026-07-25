export type RuntimeStatus = "normal" | "disabled" | "rate_limited" | "abnormal";

export interface RuntimeStatusSettings {
  error_threshold: number;
  rate_limit_backoff_seconds: number[];
  permanent_after_final_backoff: boolean;
  clear_counters_on_success: boolean;
  auth_disables_provider: boolean;
}

export const DEFAULT_RUNTIME_STATUS_SETTINGS: RuntimeStatusSettings = {
  error_threshold: 10,
  rate_limit_backoff_seconds: [30, 60, 120, 300, 600, 3600, 86400],
  permanent_after_final_backoff: true,
  clear_counters_on_success: true,
  auth_disables_provider: true
};

export const RUNTIME_STATUS_SETTINGS_KEY = "runtime_status";

export function normalizeRuntimeStatusSettings(
  input: Partial<RuntimeStatusSettings> | null | undefined
): RuntimeStatusSettings {
  const backoff = Array.isArray(input?.rate_limit_backoff_seconds)
    ? input!.rate_limit_backoff_seconds.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0
      )
    : DEFAULT_RUNTIME_STATUS_SETTINGS.rate_limit_backoff_seconds;

  const threshold =
    typeof input?.error_threshold === "number" &&
    Number.isFinite(input.error_threshold) &&
    input.error_threshold >= 1
      ? Math.floor(input.error_threshold)
      : DEFAULT_RUNTIME_STATUS_SETTINGS.error_threshold;

  return {
    error_threshold: threshold,
    rate_limit_backoff_seconds:
      backoff.length > 0 ? backoff : DEFAULT_RUNTIME_STATUS_SETTINGS.rate_limit_backoff_seconds,
    permanent_after_final_backoff:
      input?.permanent_after_final_backoff ??
      DEFAULT_RUNTIME_STATUS_SETTINGS.permanent_after_final_backoff,
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
    value === "abnormal"
  );
}

export function cooldownSecondsForStrike(
  strike: number,
  settings: RuntimeStatusSettings
): number | null {
  const ladder = settings.rate_limit_backoff_seconds;
  if (ladder.length === 0) {
    return null;
  }
  if (strike <= 0) {
    return ladder[0] ?? null;
  }
  if (strike > ladder.length) {
    return null;
  }
  return ladder[strike - 1] ?? null;
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

export function isProviderSchedulable(input: {
  enabled: boolean;
  runtimeStatus: RuntimeStatus;
}): boolean {
  if (!input.enabled) {
    return false;
  }
  return input.runtimeStatus === "normal" || input.runtimeStatus === "rate_limited";
}

export function providerFilterReason(input: {
  enabled: boolean;
  runtimeStatus: RuntimeStatus;
  statusReason?: string | null;
  statusMessage?: string | null;
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
  // provider-level rate_limited rarely used; treat like model
  if (input.runtimeStatus === "rate_limited") {
    return input.statusMessage ?? input.statusReason ?? "provider_rate_limited";
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

export type FailureClass = "auth" | "rate_limit" | "other";

export function classifyProviderFailure(error: unknown): FailureClass {
  if (!error || typeof error !== "object") {
    return "other";
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
  const message = error instanceof Error ? error.message : "";

  if (
    code === "provider_auth_failed" ||
    statusCode === 401 ||
    statusCode === 403
  ) {
    return "auth";
  }

  if (
    code === "provider_rate_limited" ||
    statusCode === 429 ||
    /status 429\b/i.test(message)
  ) {
    return "rate_limit";
  }

  return "other";
}
