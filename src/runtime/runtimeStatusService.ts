import type { ManagedProviderRepository } from "../repositories/managedProviderRepository.js";
import type { AppSettingsRepository } from "../repositories/appSettingsRepository.js";
import type { RuntimeSnapshot } from "./runtimeTypes.js";
import {
  classifyProviderFailure,
  cooldownSecondsForStrike,
  type RuntimeStatusSettings
} from "./runtimeStatus.js";
import { PROVIDER_AUTH_FAILED_CODE } from "../utils/providerErrors.js";

export function parseAccountKeyFromAccountId(accountId: string | undefined | null): string {
  if (!accountId) {
    return "default";
  }
  const parts = accountId.split("/").filter(Boolean);
  if (parts.length >= 3) {
    return parts[parts.length - 1] ?? "default";
  }
  // legacy: provider/endpoint
  return "default";
}

export class RuntimeStatusService {
  public constructor(
    private readonly managedProviders: ManagedProviderRepository,
    private readonly appSettings: AppSettingsRepository
  ) {}

  public getSettings(): RuntimeStatusSettings {
    return this.appSettings.getRuntimeStatusSettings();
  }

  public recordSuccess(input: {
    snapshot: RuntimeSnapshot;
    providerKey: string;
    modelKey: string;
    accountKey?: string;
    accountId?: string;
  }): void {
    const settings = this.getSettings();
    const accountKey =
      input.accountKey ?? parseAccountKeyFromAccountId(input.accountId);
    this.managedProviders.markAccountSuccess(
      input.providerKey,
      accountKey,
      settings.clear_counters_on_success
    );

    const row = this.managedProviders.markModelSuccess(
      input.providerKey,
      input.modelKey,
      settings.clear_counters_on_success
    );
    if (!row) {
      return;
    }
    this.patchModelStatus(input.snapshot, input.providerKey, input.modelKey, {
      runtime_status: row.runtimeStatus as "normal",
      status_reason: row.statusReason,
      status_message: row.statusMessage,
      status_cooldown_until: row.statusCooldownUntil,
      rate_limit_strike: row.rateLimitStrike,
      recent_error_count: row.recentErrorCount
    });
  }

  public recordFailure(input: {
    snapshot: RuntimeSnapshot;
    providerKey: string;
    modelKey: string;
    accountKey?: string;
    accountId?: string;
    error: unknown;
  }): void {
    const settings = this.getSettings();
    const accountKey =
      input.accountKey ?? parseAccountKeyFromAccountId(input.accountId);
    const failureClass = classifyProviderFailure(input.error);
    const message =
      input.error instanceof Error ? input.error.message : "provider_request_failed";
    const code =
      input.error &&
      typeof input.error === "object" &&
      "code" in input.error &&
      typeof input.error.code === "string"
        ? input.error.code
        : undefined;

    // 401/403 默认只打 account，不再默认禁用整个 provider。
    if (failureClass === "auth" && settings.auth_disables_provider) {
      const account = this.managedProviders.markAccountAuthFailed(
        input.providerKey,
        accountKey,
        message
      );
      if (account) {
        this.patchAccountStatus(input.snapshot, input.providerKey, accountKey, {
          available: false,
          disabled_reason: PROVIDER_AUTH_FAILED_CODE,
          disabled_message: message || "Invalid API key"
        });
      }
      return;
    }

    if (failureClass === "rate_limit") {
      const current = this.managedProviders.getModelByProviderAndKey(
        input.providerKey,
        input.modelKey
      );
      const previousStrike = current?.rateLimitStrike ?? 0;
      const nextStrike = previousStrike + 1;
      const ladder = settings.rate_limit_backoff_seconds;
      const permanent =
        settings.permanent_after_final_backoff && nextStrike > ladder.length;
      const seconds = permanent ? null : cooldownSecondsForStrike(nextStrike, settings);
      const cooldownUntil =
        seconds === null ? null : new Date(Date.now() + seconds * 1000).toISOString();
      const row = this.managedProviders.applyModelRateLimit(input.providerKey, input.modelKey, {
        strike: Math.min(nextStrike, ladder.length + 1),
        permanent,
        cooldownUntil,
        message
      });
      if (row) {
        this.patchModelStatus(input.snapshot, input.providerKey, input.modelKey, {
          runtime_status: "rate_limited",
          status_reason: row.statusReason,
          status_message: row.statusMessage,
          status_cooldown_until: row.statusCooldownUntil,
          rate_limit_strike: row.rateLimitStrike,
          recent_error_count: row.recentErrorCount
        });
      }
      return;
    }

    const current = this.managedProviders.getModelByProviderAndKey(
      input.providerKey,
      input.modelKey
    );
    const nextCount = (current?.recentErrorCount ?? 0) + 1;
    const abnormal = nextCount >= settings.error_threshold;
    const row = this.managedProviders.applyModelOtherError(input.providerKey, input.modelKey, {
      recentErrorCount: nextCount,
      abnormal,
      code,
      message
    });
    if (row) {
      this.patchModelStatus(input.snapshot, input.providerKey, input.modelKey, {
        runtime_status: row.runtimeStatus as "normal" | "abnormal" | "rate_limited" | "disabled",
        status_reason: row.statusReason,
        status_message: row.statusMessage,
        status_cooldown_until: row.statusCooldownUntil,
        rate_limit_strike: row.rateLimitStrike,
        recent_error_count: row.recentErrorCount
      });
    }
  }

  private patchAccountStatus(
    snapshot: RuntimeSnapshot,
    providerKey: string,
    accountKey: string,
    status: {
      available: boolean;
      disabled_reason?: string;
      disabled_message?: string;
    }
  ) {
    const suffix = `/${accountKey}`;
    for (const account of snapshot.accounts) {
      if (account.id.startsWith(`${providerKey}/`) && account.id.endsWith(suffix)) {
        account.available = status.available;
        account.disabled_reason = status.disabled_reason;
        account.disabled_message = status.disabled_message;
      }
    }
  }

  private patchModelStatus(
    snapshot: RuntimeSnapshot,
    providerKey: string,
    modelKey: string,
    status: {
      runtime_status: "normal" | "disabled" | "rate_limited" | "abnormal";
      status_reason?: string | null;
      status_message?: string | null;
      status_cooldown_until?: string | null;
      rate_limit_strike?: number;
      recent_error_count?: number;
    }
  ) {
    const key = `${providerKey}|${modelKey}`;
    snapshot.modelStatuses[key] = {
      provider_key: providerKey,
      model_key: modelKey,
      runtime_status: status.runtime_status,
      status_reason: status.status_reason ?? null,
      status_message: status.status_message ?? null,
      status_cooldown_until: status.status_cooldown_until ?? null,
      rate_limit_strike: status.rate_limit_strike ?? 0,
      recent_error_count: status.recent_error_count ?? 0
    };
  }
}
