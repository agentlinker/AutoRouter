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
import { SecretCipher } from "../security/secretCipher.js";
import { CredentialStore } from "./credentialStore.js";
import type { RuntimeSnapshot } from "./runtimeTypes.js";

export interface RuntimeProjectorOptions {
  baseConfig: RouterConfig;
  managedProviderRepository: ManagedProviderRepository;
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
      const accountId = `${providerId}/${bundle.endpoint.endpointKey}`;
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
        adapter: bundle.endpoint.adapterType as RouterConfig["endpoints"][string]["adapter"],
        base_url: bundle.endpoint.baseUrl,
        enabled: bundle.provider.enabled && bundle.endpoint.enabled,
        capabilities: {
          streaming: bundle.endpoint.supportsStreaming,
          tools: bundle.endpoint.supportsTools || bundle.models.some((model) => model.supportsTools),
          json_mode: bundle.endpoint.supportsJsonMode || bundle.models.some((model) => model.supportsJsonMode)
        }
      };

      mergedConfig.accounts[accountId] = {
        endpoint: endpointId,
        account_type: "api_key",
        enabled: bundle.provider.enabled && bundle.endpoint.enabled
      };

      for (const model of bundle.models) {
        if (!model.enabled) {
          continue;
        }

        const effective = resolveEffectiveModelMetadata(
          model,
          model.logicalModelId ? logicalModels.get(model.logicalModelId) ?? null : null
        );
        const modelKey =
          model.endpointId === bundle.endpoint.id || model.endpointId === null
            ? model.modelKey
            : `${providerId}/${bundle.endpoint.endpointKey}/${model.providerModelId}`;

        mergedConfig.models[modelKey] = {
          endpoint: endpointId,
          model_name: model.modelName,
          context_window: effective.contextWindow,
          capabilities: {
            streaming: effective.supportsStreaming,
            tools: effective.supportsTools,
            json_mode: effective.supportsJsonMode
          },
          pricing: parsePricingJson(effective.pricingJson)
        };
      }
    }

    const config = parseConfigSource(mergedConfig as unknown as Record<string, unknown>);
    const credentialStore = new CredentialStore(managedCredentials);
    const registry = buildProviderRegistry(config, {
      isAccountCredentialAvailable: (accountId, account) =>
        credentialStore.hasManagedCredential(accountId) ||
        Boolean(account.credential_env && process.env[account.credential_env]) ||
        account.account_type === "local_model"
    });

    return {
      config,
      logger: this.options.logger,
      platforms: registry.platforms,
      providers: registry.providers,
      endpoints: registry.endpoints,
      accounts: registry.accounts,
      priceTable: new PriceTable(config),
      adapters: this.options.adapters,
      stickySessions: this.options.stickySessions,
      traceStore: this.options.traceStore,
      modelCatalog: new ModelCatalog(config),
      credentialStore
    };
  }
}
