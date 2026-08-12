import type { ManagedProviderRepository } from "../repositories/managedProviderRepository.js";
import type { AppSettingsRepository } from "../repositories/appSettingsRepository.js";
import type { RuntimeSnapshot } from "./runtimeTypes.js";
import {
  accountUnavailableReason,
  classifyProviderFailure,
  nextCooldown,
  type FailureClass,
  type RuntimeStatus,
  type RuntimeStatusSettings
} from "./runtimeStatus.js";
import { PROVIDER_AUTH_FAILED_CODE } from "../utils/providerErrors.js";
import { accountModelStatusKey } from "../state/routerState.js";

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

interface FailureContext {
  snapshot: RuntimeSnapshot;
  providerKey: string;
  modelKey: string;
  accountKey: string;
  code?: string;
  message: string;
  settings: RuntimeStatusSettings;
}

export class RuntimeStatusService {
  public constructor(
    private readonly managedProviders: ManagedProviderRepository,
    private readonly appSettings: AppSettingsRepository
  ) {}

  public getSettings(): RuntimeStatusSettings {
    return this.appSettings.getRuntimeStatusSettings();
  }

  private toPatchedAccountStatus(account: {
    runtimeStatus: string;
    statusReason?: string | null;
    statusMessage?: string | null;
    statusCooldownUntil?: string | null;
  }): {
    available: boolean;
    runtime_status: RuntimeStatus;
    status_reason: string | null;
    status_message: string | null;
    status_cooldown_until: string | null;
    disabled_reason?: string;
    disabled_message?: string;
  } {
    const runtimeStatus = account.runtimeStatus as RuntimeStatus;
    const unavailable = accountUnavailableReason({
      runtimeStatus,
      statusReason: account.statusReason,
      statusMessage: account.statusMessage,
      statusCooldownUntil: account.statusCooldownUntil
    });
    return {
      available: unavailable === null,
      runtime_status: runtimeStatus,
      status_reason: account.statusReason ?? null,
      status_message: account.statusMessage ?? null,
      status_cooldown_until: account.statusCooldownUntil ?? null,
      disabled_reason: unavailable?.reason,
      disabled_message: unavailable?.message
    };
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
    const account = this.managedProviders.markAccountSuccess(
      input.providerKey,
      accountKey,
      settings.clear_counters_on_success
    );
    if (account && account.runtimeStatus === "normal") {
      this.patchAccountStatus(
        input.snapshot,
        input.providerKey,
        accountKey,
        this.toPatchedAccountStatus(account)
      );
    }

    const accountModel = this.managedProviders.markAccountModelSuccess(
      input.providerKey,
      accountKey,
      input.modelKey,
      settings.clear_counters_on_success
    );
    if (accountModel) {
      this.patchModelStatus(input.snapshot, input.providerKey, input.modelKey, {
        runtime_status: accountModel.runtimeStatus as RuntimeStatus,
        status_reason: accountModel.statusReason,
        status_message: accountModel.statusMessage,
        status_cooldown_until: accountModel.statusCooldownUntil,
        rate_limit_strike: accountModel.rateLimitStrike,
        recent_error_count: accountModel.recentErrorCount
      }, accountKey);
      return;
    }

    const row = this.managedProviders.markModelSuccess(
      input.providerKey,
      input.modelKey,
      settings.clear_counters_on_success
    );
    if (!row) {
      return;
    }
    this.patchModelStatus(input.snapshot, input.providerKey, input.modelKey, {
      runtime_status: row.runtimeStatus as RuntimeStatus,
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
    const failureClass = classifyProviderFailure(input.error);
    const context: FailureContext = {
      snapshot: input.snapshot,
      providerKey: input.providerKey,
      modelKey: input.modelKey,
      accountKey: input.accountKey ?? parseAccountKeyFromAccountId(input.accountId),
      code:
        input.error &&
        typeof input.error === "object" &&
        "code" in input.error &&
        typeof input.error.code === "string"
          ? input.error.code
          : undefined,
      message:
        input.error instanceof Error ? input.error.message : "provider_request_failed",
      settings
    };

    switch (failureClass) {
      case "auth":
        this.handleAuthFailure(context);
        return;
      case "billing":
        this.handleBillingFailure(context);
        return;
      case "rate_limit":
        this.handleRateLimit(context);
        return;
      case "model_unavailable":
        this.handleModelUnavailable(context);
        return;
      case "upstream_error":
        this.handleUpstreamError(context);
        return;
      case "client_error":
        this.handleClientError(context);
        return;
      case "transient":
      default:
        this.handleTransient(context);
    }
  }

  /** 401/403：只禁当前 account，不牵连同 provider 的其它凭证 */
  private handleAuthFailure(context: FailureContext): void {
    if (!context.settings.auth_disables_account) {
      this.handleTransient(context);
      return;
    }

    const account = this.managedProviders.markAccountAuthFailed(
      context.providerKey,
      context.accountKey,
      context.message
    );
    if (account) {
      this.patchAccountStatus(
        context.snapshot,
        context.providerKey,
        context.accountKey,
        this.toPatchedAccountStatus(account)
      );
    }
  }

  /** 402：余额/额度问题，需人工处理，等同 disabled */
  private handleBillingFailure(context: FailureContext): void {
    const account = this.managedProviders.markAccountBillingFailed(
      context.providerKey,
      context.accountKey,
      context.message
    );
    if (account) {
      this.patchAccountStatus(
        context.snapshot,
        context.providerKey,
        context.accountKey,
        this.toPatchedAccountStatus(account)
      );
    }
  }

  /** 429：维持 model 级限流阶梯 */
  private handleRateLimit(context: FailureContext): void {
    const currentAccountModel = this.managedProviders.getAccountModel(
      context.providerKey,
      context.accountKey,
      context.modelKey
    );
    if (currentAccountModel) {
      const decision = nextCooldown({
        previousStrike: currentAccountModel.rateLimitStrike,
        ladder: context.settings.rate_limit_backoff_seconds,
        permanentAfterFinal: context.settings.permanent_after_final_backoff
      });
      const row = this.managedProviders.applyAccountModelFailure(
        context.providerKey,
        context.accountKey,
        context.modelKey,
        {
          runtimeStatus: "rate_limited",
          reason: decision.permanent ? "rate_limited_permanent" : "rate_limited",
          cooldownUntil: decision.cooldownUntil,
          rateLimitStrike: decision.strike,
          code: context.code ?? "provider_rate_limited",
          message: context.message
        }
      );
      if (row) {
        this.patchModelStatus(context.snapshot, context.providerKey, context.modelKey, {
          runtime_status: "rate_limited",
          status_reason: row.statusReason,
          status_message: row.statusMessage,
          status_cooldown_until: row.statusCooldownUntil,
          rate_limit_strike: row.rateLimitStrike,
          recent_error_count: row.recentErrorCount
        }, context.accountKey);
      }
      return;
    }

    const current = this.managedProviders.getModelByProviderAndKey(
      context.providerKey,
      context.modelKey
    );
    const decision = nextCooldown({
      previousStrike: current?.rateLimitStrike ?? 0,
      ladder: context.settings.rate_limit_backoff_seconds,
      permanentAfterFinal: context.settings.permanent_after_final_backoff
    });

    const row = this.managedProviders.applyModelRateLimit(
      context.providerKey,
      context.modelKey,
      {
        strike: decision.strike,
        permanent: decision.permanent,
        cooldownUntil: decision.cooldownUntil,
        message: context.message
      }
    );
    if (row) {
      this.patchModelStatus(context.snapshot, context.providerKey, context.modelKey, {
        runtime_status: "rate_limited",
        status_reason: row.statusReason,
        status_message: row.statusMessage,
        status_cooldown_until: row.statusCooldownUntil,
        rate_limit_strike: row.rateLimitStrike,
        recent_error_count: row.recentErrorCount
      });
    }
  }

  /** 404/410：模型在该 provider 上不可用，与 account 无关 */
  private handleModelUnavailable(context: FailureContext): void {
    const currentAccountModel = this.managedProviders.getAccountModel(
      context.providerKey,
      context.accountKey,
      context.modelKey
    );
    if (currentAccountModel) {
      const decision = nextCooldown({
        previousStrike: currentAccountModel.cooldownStrike,
        ladder: context.settings.model_unavailable_backoff_seconds,
        permanentAfterFinal: false
      });
      const row = this.managedProviders.applyAccountModelFailure(
        context.providerKey,
        context.accountKey,
        context.modelKey,
        {
          runtimeStatus: "cooling_down",
          reason: "model_unavailable",
          cooldownUntil: decision.cooldownUntil,
          cooldownStrike: decision.strike,
          code: context.code ?? "provider_invalid_model",
          message: context.message
        }
      );
      if (row) {
        this.patchModelStatus(context.snapshot, context.providerKey, context.modelKey, {
          runtime_status: row.runtimeStatus as RuntimeStatus,
          status_reason: row.statusReason,
          status_message: row.statusMessage,
          status_cooldown_until: row.statusCooldownUntil,
          rate_limit_strike: row.rateLimitStrike,
          recent_error_count: row.recentErrorCount
        }, context.accountKey);
      }
      return;
    }

    const current = this.managedProviders.getModelByProviderAndKey(
      context.providerKey,
      context.modelKey
    );
    const decision = nextCooldown({
      previousStrike: current?.cooldownStrike ?? 0,
      ladder: context.settings.model_unavailable_backoff_seconds,
      // 中转站返 410 也可能是自身抽风，保持可自愈，不做永久禁用
      permanentAfterFinal: false
    });

    const row = this.managedProviders.applyModelUnavailable(
      context.providerKey,
      context.modelKey,
      {
        strike: decision.strike,
        permanent: decision.permanent,
        cooldownUntil: decision.cooldownUntil,
        code: context.code,
        message: context.message
      }
    );
    if (row) {
      this.patchModelStatus(context.snapshot, context.providerKey, context.modelKey, {
        runtime_status: row.runtimeStatus as RuntimeStatus,
        status_reason: row.statusReason,
        status_message: row.statusMessage,
        status_cooldown_until: row.statusCooldownUntil,
        rate_limit_strike: row.rateLimitStrike,
        recent_error_count: row.recentErrorCount
      });
    }
  }

  /** 上游返回的 HTTP 408/5xx 可能是中转站内部渠道错误，只冷却实际失败的模型。 */
  private handleUpstreamError(context: FailureContext): void {
    const currentAccountModel = this.managedProviders.getAccountModel(
      context.providerKey,
      context.accountKey,
      context.modelKey
    );
    const previousStrike = currentAccountModel?.cooldownStrike ??
      this.managedProviders.getModelByProviderAndKey(
        context.providerKey,
        context.modelKey
      )?.cooldownStrike ??
      0;
    const decision = nextCooldown({
      previousStrike,
      ladder: context.settings.error_backoff_seconds,
      permanentAfterFinal: context.settings.error_permanent_after_final_backoff
    });

    if (currentAccountModel) {
      const row = this.managedProviders.applyAccountModelFailure(
        context.providerKey,
        context.accountKey,
        context.modelKey,
        {
          runtimeStatus: decision.permanent ? "abnormal" : "cooling_down",
          reason: decision.permanent ? "upstream_error_permanent" : "upstream_error_cooldown",
          cooldownUntil: decision.cooldownUntil,
          cooldownStrike: decision.strike,
          code: context.code,
          message: context.message
        }
      );
      if (row) {
        this.patchModelStatus(context.snapshot, context.providerKey, context.modelKey, {
          runtime_status: row.runtimeStatus as RuntimeStatus,
          status_reason: row.statusReason,
          status_message: row.statusMessage,
          status_cooldown_until: row.statusCooldownUntil,
          rate_limit_strike: row.rateLimitStrike,
          recent_error_count: row.recentErrorCount
        }, context.accountKey);
      }
      return;
    }

    const row = this.managedProviders.applyModelCooldown(
      context.providerKey,
      context.modelKey,
      {
        strike: decision.strike,
        permanent: decision.permanent,
        cooldownUntil: decision.cooldownUntil,
        reason: decision.permanent ? "upstream_error_permanent" : "upstream_error_cooldown",
        code: context.code,
        message: context.message
      }
    );
    if (row) {
      this.patchModelStatus(context.snapshot, context.providerKey, context.modelKey, {
        runtime_status: row.runtimeStatus as RuntimeStatus,
        status_reason: row.statusReason,
        status_message: row.statusMessage,
        status_cooldown_until: row.statusCooldownUntil,
        rate_limit_strike: row.rateLimitStrike,
        recent_error_count: row.recentErrorCount
      });
    }
  }

  /**
   * 无法连接上游：冷却打在 account（节点）层，首次报错即生效。
   * 同步 patch 内存快照，让当前这次请求的后续候选立刻跳过该节点下所有模型。
   */
  private handleTransient(context: FailureContext): void {
    const currentAccount = this.managedProviders.getAccount(
      context.providerKey,
      context.accountKey
    );
    const decision = nextCooldown({
      previousStrike: currentAccount?.cooldownStrike ?? 0,
      ladder: context.settings.error_backoff_seconds,
      permanentAfterFinal: context.settings.error_permanent_after_final_backoff
    });

    const account = this.managedProviders.applyAccountCooldown(
      context.providerKey,
      context.accountKey,
      {
        strike: decision.strike,
        permanent: decision.permanent,
        cooldownUntil: decision.cooldownUntil,
        code: context.code,
        message: context.message
      }
    );
    if (account) {
      this.patchAccountStatus(
        context.snapshot,
        context.providerKey,
        context.accountKey,
        this.toPatchedAccountStatus(account)
      );
    }

  }

  /**
   * 400/409/413/422：无法区分是我们的请求有问题还是这个节点限制更严
   * （413 明确是节点 body 上限更低），惩罚会误杀好节点，因此只留痕不改状态。
   */
  private handleClientError(context: FailureContext): void {
    this.managedProviders.recordAccountClientError(context.providerKey, context.accountKey, {
      code: context.code,
      message: context.message
    });
    const accountModel = this.managedProviders.recordAccountModelClientError(
      context.providerKey,
      context.accountKey,
      context.modelKey,
      {
        code: context.code,
        message: context.message
      }
    );
    if (accountModel) {
      return;
    }
    this.managedProviders.recordModelClientError(context.providerKey, context.modelKey, {
      code: context.code,
      message: context.message
    });
  }

  private patchAccountStatus(
    snapshot: RuntimeSnapshot,
    providerKey: string,
    accountKey: string,
    status: {
      available: boolean;
      runtime_status?: RuntimeStatus;
      status_reason?: string | null;
      status_message?: string | null;
      status_cooldown_until?: string | null;
      disabled_reason?: string;
      disabled_message?: string;
    }
  ) {
    const suffix = `/${accountKey}`;
    for (const account of snapshot.accounts) {
      if (account.id.startsWith(`${providerKey}/`) && account.id.endsWith(suffix)) {
        account.available = status.available;
        if ("runtime_status" in status) {
          account.runtime_status = status.runtime_status;
        }
        if ("status_reason" in status) {
          account.status_reason = status.status_reason ?? null;
        }
        if ("status_message" in status) {
          account.status_message = status.status_message ?? null;
        }
        if ("status_cooldown_until" in status) {
          account.status_cooldown_until = status.status_cooldown_until ?? null;
        }
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
      runtime_status: RuntimeStatus;
      status_reason?: string | null;
      status_message?: string | null;
      status_cooldown_until?: string | null;
      rate_limit_strike?: number;
      recent_error_count?: number;
    },
    accountKey?: string
  ) {
    const entry = {
      provider_key: providerKey,
      model_key: modelKey,
      runtime_status: status.runtime_status,
      status_reason: status.status_reason ?? null,
      status_message: status.status_message ?? null,
      status_cooldown_until: status.status_cooldown_until ?? null,
      rate_limit_strike: status.rate_limit_strike ?? 0,
      recent_error_count: status.recent_error_count ?? 0
    };
    if (accountKey) {
      const suffix = `/${accountKey}`;
      for (const account of snapshot.accounts) {
        if (account.id.startsWith(`${providerKey}/`) && account.id.endsWith(suffix)) {
          snapshot.modelStatuses[accountModelStatusKey(account.id, modelKey)] = entry;
        }
      }
      return;
    }
    snapshot.modelStatuses[`${providerKey}|${modelKey}`] = entry;
  }
}

export type { FailureClass };
