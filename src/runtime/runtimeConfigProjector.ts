import { buildProviderRegistry } from "../catalog/providerRegistry.js";
import { ModelCatalog } from "../catalog/modelCatalog.js";
import { PriceTable } from "../catalog/priceTable.js";
import { parseConfigSource } from "../config/loadConfig.js";
import type { RouterConfig } from "../config/schema.js";
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

export class RuntimeConfigProjector {
  public constructor(private readonly options: RuntimeProjectorOptions) {}

  public project(): RuntimeSnapshot {
    const mergedConfig = structuredClone(this.options.baseConfig) as RouterConfig;
    const managedBundles = this.options.managedProviderRepository.listEnabledProviderBundles();
    const managedCredentials = new Map<string, string>();

    for (const bundle of managedBundles) {
      const providerId = bundle.provider.providerKey;
      const endpointId = `${providerId}/default`;
      const accountId = `${providerId}/default`;
      const decryptedCredential = this.options.secretCipher.decrypt(
        bundle.credential.apiKeyEncrypted
      );

      managedCredentials.set(accountId, decryptedCredential);

      mergedConfig.platforms.openai ??= {
        protocol: "openai"
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
        platform: "openai",
        adapter: bundle.provider.adapterType as RouterConfig["endpoints"][string]["adapter"],
        base_url: bundle.provider.baseUrl,
        enabled: bundle.provider.enabled,
        capabilities: {
          streaming: true,
          tools: bundle.models.some((model) => model.supportsTools),
          json_mode: bundle.models.some((model) => model.supportsJsonMode)
        }
      };

      mergedConfig.accounts[accountId] = {
        endpoint: endpointId,
        account_type: "api_key",
        enabled: bundle.provider.enabled
      };

      for (const model of bundle.models) {
        mergedConfig.models[model.modelKey] = {
          endpoint: endpointId,
          model_name: model.modelName,
          context_window: model.contextWindow ?? undefined,
          capabilities: {
            streaming: model.supportsStreaming,
            tools: model.supportsTools,
            json_mode: model.supportsJsonMode
          },
          pricing: model.pricingJson
            ? JSON.parse(model.pricingJson)
            : undefined
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
