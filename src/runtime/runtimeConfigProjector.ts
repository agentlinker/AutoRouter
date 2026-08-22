import { buildProviderRegistry } from "../catalog/providerRegistry.js";
import { resolveEffectiveModelMetadata } from "../catalog/effectiveModelMetadata.js";
import { ModelCatalog } from "../catalog/modelCatalog.js";
import { PriceTable } from "../catalog/priceTable.js";
import { parseConfigSource } from "../config/loadConfig.js";
import type { PriceEntryConfig, RouterConfig } from "../config/schema.js";
import type { AdapterRegistry } from "../providers/registry.js";
import type { StickySessionStore } from "../routing/stickySession.js";
import type { TraceStore } from "../trace/traceStore.js";
import type pino from "pino";

import type { ManagedProviderRepository } from "../repositories/managedProviderRepository.js";
import { parseAccountQuota } from "../repositories/managedProviderRepository.js";
import { SecretCipher } from "../security/secretCipher.js";
import { CredentialStore } from "./credentialStore.js";
import type { RuntimeSnapshot } from "./runtimeTypes.js";
import {
  DEFAULT_RUNTIME_STATUS_SETTINGS,
  accountUnavailableReason,
  isRuntimeStatusValue,
  type RuntimeStatus
} from "./runtimeStatus.js";
import type { AppSettingsRepository } from "../repositories/appSettingsRepository.js";
import { accountModelStatusKey } from "../state/routerState.js";

export interface RuntimeProjectorOptions {
  baseConfig: RouterConfig;
  managedProviderRepository: ManagedProviderRepository;
  appSettingsRepository?: AppSettingsRepository;
  secretCipher: SecretCipher;
  adapters: AdapterRegistry;
  stickySessions: StickySessionStore;
  traceStore: TraceStore;
  logger: pino.Logger;
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parsePricingJson(pricingJson: string | null | undefined): PriceEntryConfig | undefined {
  if (!pricingJson) {
    return undefined;
  }

  let parsed;
  try {
    parsed = JSON.parse(pricingJson) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const source: PriceEntryConfig["source"] =
    record.source === "official" ||
    record.source === "openrouter" ||
    record.source === "manual" ||
    record.source === "estimated"
      ? record.source
      : "manual";
  const confidence: PriceEntryConfig["confidence"] =
    record.confidence === "low" ||
    record.confidence === "medium" ||
    record.confidence === "high"
      ? record.confidence
      : "low";

  return {
    input_per_1m: numberFromRecord(record, "input_per_1m") ?? numberFromRecord(record, "input"),
    output_per_1m: numberFromRecord(record, "output_per_1m") ?? numberFromRecord(record, "output"),
    cached_input_per_1m:
      numberFromRecord(record, "cached_input_per_1m") ?? numberFromRecord(record, "cacheRead"),
    source,
    confidence
  };
}

/**
 * aliases 在 DB 里是 JSON 数组文本。解析失败当作没有别名：
 * 别名是可选增强项，不该因为一条脏数据让模型不可用。
 */
function parseAliases(aliasesJson: string | null | undefined): string[] {
  if (!aliasesJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(aliasesJson) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

/**
 * custom_headers 在 DB 里是 JSON 文本。解析失败当作未配置：
 * header 是可选增强项，不该因为一条脏数据让整个 provider 不可用。
 */
function parseCustomHeaders(
  customHeadersJson: string | null | undefined
): Record<string, string> | undefined {
  if (!customHeadersJson) {
    return undefined;
  }

  let parsed;
  try {
    parsed = JSON.parse(customHeadersJson) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") {
      headers[name] = value;
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

export class RuntimeConfigProjector {
  public constructor(private readonly options: RuntimeProjectorOptions) {}

  public project(): RuntimeSnapshot {
    const mergedConfig = structuredClone(this.options.baseConfig) as RouterConfig;
    const managedBundles = this.options.managedProviderRepository.listEnabledProviderBundles();
    const managedCredentials = new Map<string, string>();
    const logicalIds = Array.from(new Set(
      managedBundles.flatMap((bundle) =>
        bundle.models.flatMap((model) => model.logicalModelId ? [model.logicalModelId] : [])
      )
    ));
    const logicalModels =
      this.options.managedProviderRepository.listLogicalModelsByIds(logicalIds);

    for (const bundle of managedBundles) {
      const providerId = bundle.provider.providerKey;
      const endpointId = `${providerId}/${bundle.endpoint.endpointKey}`;
      const accountKey = bundle.credential.accountKey || "default";
      const accountId = `${providerId}/${bundle.endpoint.endpointKey}/${accountKey}`;
      const decryptedCredential = this.options.secretCipher.decrypt(
        bundle.credential.apiKeyEncrypted
      );

      managedCredentials.set(accountId, decryptedCredential);

      mergedConfig.platforms[bundle.endpoint.protocol] ??= {
        protocol: bundle.endpoint.protocol
      };

      mergedConfig.providers[providerId] = {
        display_name: bundle.provider.displayName,
        trust_level: bundle.provider.trustLevel as RouterConfig["providers"][string]["trust_level"],
        privacy_level:
          bundle.provider.privacyLevel as RouterConfig["providers"][string]["privacy_level"],
        usage_trust:
          bundle.provider.usageTrust as RouterConfig["providers"][string]["usage_trust"]
      };

      mergedConfig.endpoints[endpointId] = {
        provider: providerId,
        platform: bundle.endpoint.protocol,
        base_url: bundle.endpoint.baseUrl,
        custom_headers: parseCustomHeaders(bundle.endpoint.customHeadersJson),
        enabled: bundle.provider.enabled && bundle.endpoint.enabled,
        capabilities: {
          streaming: bundle.endpoint.supportsStreaming,
          tools: bundle.endpoint.supportsTools || bundle.models.some((model) => model.supportsTools),
          json_mode: bundle.endpoint.supportsJsonMode || bundle.models.some((model) => model.supportsJsonMode)
        }
      };

      const accountEnabled =
        bundle.provider.enabled &&
        bundle.endpoint.enabled &&
        bundle.credential.enabled !== false;
      const perAccount = bundle.provider.modelAvailabilityScope === "per_account";
      const allowedModels: string[] = [];

      for (const model of bundle.models) {
        if (!model.enabled) {
          continue;
        }

        const logical = model.logicalModelId
          ? logicalModels.get(model.logicalModelId) ?? null
          : null;
        const effective = resolveEffectiveModelMetadata(model, logical);
        const modelKey =
          model.endpointId === bundle.endpoint.id || model.endpointId === null
            ? model.modelKey
            : `${providerId}/${bundle.endpoint.endpointKey}/${model.providerModelId}`;

        allowedModels.push(modelKey);
        mergedConfig.models[modelKey] = {
          endpoint: endpointId,
          model_name: model.modelName,
          // 上游真实 id 也要能直接请求：中转站常以 deepseek-ai/deepseek-v4-pro 这类
          // 带命名空间的写法暴露模型，客户端照抄过来必须解析得到。
          aliases: parseAliases(logical?.aliasesJson),
          context_window: effective.contextWindow,
          capabilities: {
            streaming: effective.supportsStreaming,
            tools: effective.supportsTools,
            json_mode: effective.supportsJsonMode
          },
          pricing: parsePricingJson(effective.pricingJson)
        };
      }

      const existingAccount = mergedConfig.accounts[accountId];
      const mergedAllowed = perAccount
        ? Array.from(new Set([
            ...(existingAccount?.allowed_models ?? []),
            ...allowedModels
          ]))
        : undefined;

      mergedConfig.accounts[accountId] = {
        endpoint: endpointId,
        account_type: "api_key",
        enabled: accountEnabled,
        quota: parseAccountQuota(bundle.credential.quotaJson),
        ...(mergedAllowed ? { allowed_models: mergedAllowed } : {})
      };
    }

    const config = parseConfigSource(mergedConfig as unknown as Record<string, unknown>);
    const credentialStore = new CredentialStore(managedCredentials);
    const registry = buildProviderRegistry(config, {
      isAccountCredentialAvailable: (accountId, account) =>
        credentialStore.hasManagedCredential(accountId) ||
        Boolean(account.credential_env && process.env[account.credential_env]) ||
        account.account_type === "local_model"
    });

    const modelStatuses: RuntimeSnapshot["modelStatuses"] = {};
    const managedProviderByKey = new Map(
      managedBundles.map((bundle) => [bundle.provider.providerKey, bundle.provider] as const)
    );

    for (const provider of registry.providers) {
      const managed = managedProviderByKey.get(provider.id);
      if (!managed) {
        continue;
      }
      provider.priority = managed.priority ?? 0;
    }

    const now = new Date();
    for (const bundle of managedBundles) {
      const accountKey = bundle.credential.accountKey || "default";
      const accountId = `${bundle.provider.providerKey}/${bundle.endpoint.endpointKey}/${accountKey}`;
      const account = registry.accounts.find((item) => item.id === accountId);
      if (account) {
        account.provider_key = bundle.provider.providerKey;
        account.endpoint_key = bundle.endpoint.endpointKey;
        account.account_key = accountKey;
        account.api_key_hint = bundle.credential.keyHint ?? undefined;
        account.recent_error_count = bundle.credential.recentErrorCount ?? 0;
        const accountStatus = isRuntimeStatusValue(bundle.credential.runtimeStatus)
          ? bundle.credential.runtimeStatus
          : "normal";
        account.runtime_status = accountStatus as RuntimeStatus;
        account.status_reason = bundle.credential.statusReason ?? null;
        account.status_message = bundle.credential.statusMessage ?? null;
        account.status_cooldown_until = bundle.credential.statusCooldownUntil ?? null;

        if (bundle.credential.expiresAt) {
          const expiresAt = Date.parse(bundle.credential.expiresAt);
          if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
            account.available = false;
            account.disabled_reason = "account_expired";
            account.disabled_message = "Account expired";
          }
        }

        const unavailable = accountUnavailableReason({
          runtimeStatus: accountStatus,
          statusReason: bundle.credential.statusReason,
          statusMessage: bundle.credential.statusMessage,
          statusCooldownUntil: bundle.credential.statusCooldownUntil,
          now
        });
        if (unavailable) {
          account.available = false;
          account.disabled_reason = unavailable.reason;
          account.disabled_message = unavailable.message;
        }

        if (
          account.quota?.remaining_usd !== undefined &&
          account.quota.remaining_usd <= 0
        ) {
          account.available = false;
          account.disabled_reason = "account_quota_exhausted";
          account.disabled_message = "Account quota exhausted";
        }
      }

      for (const model of bundle.models) {
        if (!model.enabled) {
          continue;
        }
        const status = isRuntimeStatusValue(model.runtimeStatus) ? model.runtimeStatus : "normal";
        const statusEntry = {
          provider_key: bundle.provider.providerKey,
          model_key: model.modelKey,
          runtime_status: status as RuntimeStatus,
          status_reason: model.statusReason,
          status_message: model.statusMessage,
          status_cooldown_until: model.statusCooldownUntil,
          rate_limit_strike: model.rateLimitStrike ?? 0,
          recent_error_count: model.recentErrorCount ?? 0
        };
        modelStatuses[`${bundle.provider.providerKey}|${model.modelKey}`] = statusEntry;
        // Also index by projected config model id for routeEngine lookups.
        const configModelId =
          model.endpointId === bundle.endpoint.id || model.endpointId === null
            ? model.modelKey
            : `${bundle.provider.providerKey}/${bundle.endpoint.endpointKey}/${model.providerModelId}`;
        modelStatuses[configModelId] = statusEntry;
        modelStatuses[`${bundle.provider.providerKey}|${configModelId}`] = statusEntry;

        const accountModel = this.options.managedProviderRepository.getAccountModel(
          bundle.provider.providerKey,
          accountKey,
          model.modelKey
        );
        if (accountModel) {
          const accountStatus = isRuntimeStatusValue(accountModel.runtimeStatus)
            ? accountModel.runtimeStatus
            : "normal";
          const accountStatusEntry = {
            provider_key: bundle.provider.providerKey,
            model_key: model.modelKey,
            runtime_status: accountStatus as RuntimeStatus,
            status_reason: accountModel.statusReason,
            status_message: accountModel.statusMessage,
            status_cooldown_until: accountModel.statusCooldownUntil,
            rate_limit_strike: accountModel.rateLimitStrike ?? 0,
            recent_error_count: accountModel.recentErrorCount ?? 0
          };
          modelStatuses[accountModelStatusKey(accountId, model.modelKey)] = accountStatusEntry;
          modelStatuses[accountModelStatusKey(accountId, configModelId)] = accountStatusEntry;
          modelStatuses[accountModelStatusKey(accountId, model.providerModelId)] =
            accountStatusEntry;
        }
      }
    }

    const runtimeStatusSettings =
      this.options.appSettingsRepository?.getRuntimeStatusSettings() ??
      DEFAULT_RUNTIME_STATUS_SETTINGS;

    return {
      config,
      logger: this.options.logger,
      platforms: registry.platforms,
      providers: registry.providers,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      modelStatuses,
      runtimeStatusSettings,
      priceTable: new PriceTable(config),
      adapters: this.options.adapters,
      stickySessions: this.options.stickySessions,
      traceStore: this.options.traceStore,
      modelCatalog: new ModelCatalog(config),
      credentialStore
    };
  }
}
