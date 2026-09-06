import type { ManagedProviderRepository } from "../repositories/managedProviderRepository.js";
import type { AppSettingsRepository } from "../repositories/appSettingsRepository.js";
import type { RuntimeSnapshot } from "./runtimeTypes.js";
import {
  accountUnavailableReason,
  nextCooldown,
  type RuntimeStatus,
  type RuntimeStatusSettings
} from "./runtimeStatus.js";
import { accountModelStatusKey } from "../state/routerState.js";
import { wireProtocolSchema } from "../config/schema.js";
import {
  classifyProviderFailure,
  type StructuredProviderFailure
} from "./providerFailure.js";

interface FailureContext {
  snapshot: RuntimeSnapshot;
  providerKey: string;
  modelKey: string;
  accountKey: string;
  endpointKey: string;
  code?: string;
  message: string;
  settings: RuntimeStatusSettings;
  failure: StructuredProviderFailure;
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
    accountKey: string;
    endpointKey: string;
  }): void {
    const settings = this.getSettings();
    const account = this.managedProviders.markAccountSuccess(
      input.providerKey,
      input.accountKey,
      settings.clear_counters_on_success
    );
    if (account && account.runtimeStatus === "normal") {
      this.patchAccountStatus(
        input.snapshot,
        input.providerKey,
        input.accountKey,
        this.toPatchedAccountStatus(account)
      );
    }

    this.managedProviders.markEndpointSuccess(
      input.providerKey,
      input.endpointKey,
      settings.clear_counters_on_success
    );
    this.managedProviders.markAccountEndpointSuccess(
      input.providerKey,
      input.accountKey,
      input.endpointKey,
      settings.clear_counters_on_success
    );
    const accountModel = this.managedProviders.markAccountEndpointModelSuccess(
      input.providerKey,
      input.accountKey,
      input.endpointKey,
      input.modelKey,
      settings.clear_counters_on_success
    );
    if (!accountModel) {
      return;
    }
    this.patchModelStatus(input.snapshot, input.providerKey, input.modelKey, {
      runtime_status: accountModel.runtimeStatus as RuntimeStatus,
      status_reason: accountModel.statusReason,
      status_message: accountModel.statusMessage,
      status_cooldown_until: accountModel.statusCooldownUntil,
      rate_limit_strike: accountModel.rateLimitStrike,
      recent_error_count: accountModel.recentErrorCount
    }, input.accountKey, input.endpointKey);
  }

  public recordFailure(input: {
    snapshot: RuntimeSnapshot;
    providerKey: string;
    modelKey: string;
    accountKey: string;
    endpointKey: string;
    error: unknown;
  }): void {
    const settings = this.getSettings();
    const endpoint = input.snapshot.endpoints.find(
      (item) => item.id === `${input.providerKey}/${input.endpointKey}`
    );
    const failure = classifyProviderFailure(input.error, {
      protocol: wireProtocolSchema.parse(
        input.snapshot.platforms.find((item) => item.id === endpoint?.platform_id)?.protocol
      )
    });
    const context: FailureContext = {
      snapshot: input.snapshot,
      providerKey: input.providerKey,
      modelKey: input.modelKey,
      accountKey: input.accountKey,
      endpointKey: input.endpointKey,
      code:
        input.error &&
        typeof input.error === "object" &&
        "code" in input.error &&
        typeof input.error.code === "string"
          ? input.error.code
          : undefined,
      message:
        input.error instanceof Error ? input.error.message : "provider_request_failed",
      settings,
      failure
    };

    switch (failure.scope) {
      case "account":
        if (failure.kind === "billing") this.handleBillingFailure(context);
        else this.handleAuthFailure(context);
        return;
      case "endpoint":
        this.handleTransient(context);
        return;
      case "account-endpoint":
        this.handleAccountEndpointFailure(context);
        return;
      case "account-endpoint-model":
        if (failure.kind === "rate-limit") this.handleRateLimit(context);
        else if (failure.kind === "model-unavailable") this.handleModelUnavailable(context);
        else this.handleUpstreamError(context);
        return;
      case "request":
      case "unknown":
        return;
    }
  }

  /** 只有结构化 scope=account 的明确凭证证据才禁用 Account。 */
  private handleAuthFailure(context: FailureContext): void {
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

  private handleAccountEndpointFailure(context: FailureContext): void {
    const row = this.managedProviders.applyAccountEndpointFailure(
      context.providerKey,
      context.accountKey,
      context.endpointKey,
      {
        runtimeStatus: "disabled",
        reason: context.failure.kind === "authentication" ? "authentication_failed" : "access_denied",
        cooldownUntil: null,
        code: context.code,
        message: context.message
      }
    );
    if (row) {
      this.patchAccountEndpointStatus(context.snapshot, context.providerKey, context.accountKey,
        context.endpointKey, row.runtimeStatus as RuntimeStatus, row.statusReason, row.statusMessage);
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

  /** 429：只影响实际失败的 Account-Endpoint-Model。 */
  private handleRateLimit(context: FailureContext): void {
    const current = this.managedProviders.getAccountEndpointModel(
      context.providerKey,
      context.accountKey,
      context.endpointKey,
      context.modelKey
    );
    const decision = nextCooldown({
      previousStrike: current?.rateLimitStrike ?? 0,
      ladder: context.settings.rate_limit_backoff_seconds,
      permanentAfterFinal: context.settings.permanent_after_final_backoff
    });
    const row = this.managedProviders.applyAccountEndpointModelFailure(
      context.providerKey,
      context.accountKey,
      context.endpointKey,
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
        runtime_status: row.runtimeStatus as RuntimeStatus,
        status_reason: row.statusReason,
        status_message: row.statusMessage,
        status_cooldown_until: row.statusCooldownUntil,
        rate_limit_strike: row.rateLimitStrike,
        recent_error_count: row.recentErrorCount
      }, context.accountKey, context.endpointKey);
    }
  }

  /** 404/410：只影响实际失败的 Account-Endpoint-Model。 */
  private handleModelUnavailable(context: FailureContext): void {
    const current = this.managedProviders.getAccountEndpointModel(
      context.providerKey,
      context.accountKey,
      context.endpointKey,
      context.modelKey
    );
    const decision = nextCooldown({
      previousStrike: current?.cooldownStrike ?? 0,
      ladder: context.settings.model_unavailable_backoff_seconds,
      permanentAfterFinal: false
    });
    const row = this.managedProviders.applyAccountEndpointModelFailure(
      context.providerKey,
      context.accountKey,
      context.endpointKey,
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
      }, context.accountKey, context.endpointKey);
    }
  }

  /** 上游 HTTP 408/5xx 只冷却实际失败的 Account-Endpoint-Model。 */
  private handleUpstreamError(context: FailureContext): void {
    const current = this.managedProviders.getAccountEndpointModel(
      context.providerKey,
      context.accountKey,
      context.endpointKey,
      context.modelKey
    );
    const decision = nextCooldown({
      previousStrike: current?.cooldownStrike ?? 0,
      ladder: context.settings.error_backoff_seconds,
      permanentAfterFinal: context.settings.error_permanent_after_final_backoff
    });
    const row = this.managedProviders.applyAccountEndpointModelFailure(
      context.providerKey,
      context.accountKey,
      context.endpointKey,
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
      }, context.accountKey, context.endpointKey);
    }
  }

  /**
   * 无法连接上游：冷却打在 Endpoint 层，首次报错即生效。
   */
  private handleTransient(context: FailureContext): void {
    const currentEndpoint = this.managedProviders.getProviderEndpoint(
      context.providerKey,
      context.endpointKey
    );
    const decision = nextCooldown({
      previousStrike: currentEndpoint?.cooldownStrike ?? 0,
      ladder: context.settings.error_backoff_seconds,
      permanentAfterFinal: context.settings.error_permanent_after_final_backoff
    });

    const endpoint = this.managedProviders.applyEndpointCooldown(
      context.providerKey,
      context.endpointKey,
      {
        strike: decision.strike,
        permanent: decision.permanent,
        cooldownUntil: decision.cooldownUntil,
        code: context.code,
        message: context.message
      }
    );
    if (endpoint) {
      this.patchEndpointStatus(
        context.snapshot,
        context.providerKey,
        context.endpointKey,
        {
          runtime_status: endpoint.runtimeStatus as RuntimeStatus,
          status_reason: endpoint.statusReason,
          status_message: endpoint.statusMessage,
          status_cooldown_until: endpoint.statusCooldownUntil
        }
      );
    }
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
    accountKey?: string,
    endpointKey?: string
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
    if (accountKey && endpointKey) {
      const accountId = `${providerKey}/${accountKey}`;
      const providerPrefix = `${providerKey}/`;
      const providerModelId = modelKey.startsWith(providerPrefix)
        ? modelKey.slice(providerPrefix.length)
        : modelKey;
      const modelAliases = new Set([
        modelKey,
        providerModelId,
        `${providerKey}/${endpointKey}/${providerModelId}`
      ]);
      for (const modelAlias of modelAliases) {
        snapshot.modelStatuses[accountModelStatusKey(accountId, modelAlias)] = entry;
      }
      return;
    }
    snapshot.modelStatuses[`${providerKey}|${modelKey}`] = entry;
  }

  private patchEndpointStatus(
    snapshot: RuntimeSnapshot,
    providerKey: string,
    endpointKey: string,
    status: {
      runtime_status: RuntimeStatus;
      status_reason?: string | null;
      status_message?: string | null;
      status_cooldown_until?: string | null;
    }
  ): void {
    const endpoint = snapshot.endpoints.find(
      (item) => item.id === `${providerKey}/${endpointKey}`
    );
    if (!endpoint) {
      return;
    }
    endpoint.runtime_status = status.runtime_status;
    endpoint.status_reason = status.status_reason ?? null;
    endpoint.status_message = status.status_message ?? null;
    endpoint.status_cooldown_until = status.status_cooldown_until ?? null;
  }

  private patchAccountEndpointStatus(
    snapshot: RuntimeSnapshot,
    providerKey: string,
    accountKey: string,
    endpointKey: string,
    runtimeStatus: RuntimeStatus,
    reason?: string | null,
    message?: string | null
  ): void {
    const accountId = `${providerKey}/${accountKey}`;
    const endpointId = `${providerKey}/${endpointKey}`;
    const existing = snapshot.accountEndpoints.find((item) =>
      item.account_id === accountId && item.endpoint_id === endpointId
    );
    if (existing) {
      existing.runtime_status = runtimeStatus;
      existing.status_reason = reason ?? null;
      existing.status_message = message ?? null;
      return;
    }
    snapshot.accountEndpoints.push({
      account_id: accountId,
      endpoint_id: endpointId,
      enabled: true,
      runtime_status: runtimeStatus,
      status_reason: reason ?? null,
      status_message: message ?? null,
      recent_error_count: 1
    });
  }
}
