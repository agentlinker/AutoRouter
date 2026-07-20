import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq } from "drizzle-orm";

import {
  managedModelsTable,
  managedProviderCredentialsTable,
  managedProviderEndpointsTable,
  managedProvidersTable,
  modelSyncRunsTable,
  type ManagedCredentialRow,
  type ManagedModelRow,
  type ManagedProviderEndpointRow,
  type ManagedProviderRow,
  type ModelSyncRunRow,
  type schema
} from "../db/schema.js";

export interface ManagedProviderInput {
  providerKey: string;
  displayName: string;
  adapterType: "openai_compatible" | "openrouter" | "anthropic";
  baseUrl: string;
  websiteUrl?: string | null;
  enabled?: boolean;
  trustLevel?: "low" | "medium" | "high";
  privacyLevel?: "public_only" | "normal" | "private";
  usageTrust?: "low" | "medium" | "high";
}

export interface ManagedEndpointInput {
  endpointKey: string;
  protocol: "openai" | "anthropic";
  adapterType: "openai_compatible" | "openrouter" | "anthropic";
  baseUrl: string;
  enabled?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonMode?: boolean;
}

export interface ManagedEndpointBundleInput {
  endpoint: ManagedEndpointInput;
  models: ManagedDiscoveredModelInput[];
}

export interface ManagedDiscoveredModelInput {
  modelKey: string;
  providerModelId: string;
  modelName: string;
  contextWindow?: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsJsonMode: boolean;
  pricingJson?: string;
  rawMetadataJson?: string;
}

export interface ManagedProviderUpdateInput {
  displayName?: string;
  protocol?: "openai" | "anthropic";
  baseUrl?: string;
  websiteUrl?: string | null;
  enabled?: boolean;
}

export interface ManagedEndpointUpdateInput {
  protocol?: "openai" | "anthropic";
  adapterType?: "openai_compatible" | "openrouter" | "anthropic";
  baseUrl?: string;
  enabled?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonMode?: boolean;
}

export interface ManagedModelCapabilitiesUpdateInput {
  modelKey: string;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonMode?: boolean;
}

export interface ManagedProviderDetails {
  provider: ManagedProviderRow;
  credential: ManagedCredentialRow | null;
  endpoints: ManagedProviderEndpointRow[];
  models: ManagedModelRow[];
  latestSync: ModelSyncRunRow | null;
}

type Db = BetterSQLite3Database<typeof schema>;

function nowIso(): string {
  return new Date().toISOString();
}

function keyHintFromApiKey(apiKey: string): string {
  const suffix = apiKey.slice(-4);
  return suffix ? `...${suffix}` : "hidden";
}

export class ManagedProviderRepository {
  public constructor(private readonly db: Db) {}

  public listProviderSummaries(): ManagedProviderDetails[] {
    const providers = this.db.select().from(managedProvidersTable).all();
    return providers.map((provider) => this.getProviderDetails(provider.providerKey)).filter(
      (item): item is ManagedProviderDetails => item !== null
    );
  }

  public getProviderDetails(providerKey: string): ManagedProviderDetails | null {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();

    if (!provider) {
      return null;
    }

    const credential = this.db.select().from(managedProviderCredentialsTable)
      .where(eq(managedProviderCredentialsTable.providerId, provider.id))
      .get() ?? null;

    const endpoints = this.db.select().from(managedProviderEndpointsTable)
      .where(eq(managedProviderEndpointsTable.providerId, provider.id))
      .all();

    const models = this.db.select().from(managedModelsTable)
      .where(eq(managedModelsTable.providerId, provider.id))
      .all();

    const latestSync = this.db.select().from(modelSyncRunsTable)
      .where(eq(modelSyncRunsTable.providerId, provider.id))
      .orderBy(desc(modelSyncRunsTable.startedAt))
      .limit(1)
      .get() ?? null;

    return { provider, credential, endpoints, models, latestSync };
  }

  public createProviderWithModels(input: {
    provider: ManagedProviderInput;
    encryptedApiKey: string;
    apiKeyHint?: string;
    models: ManagedDiscoveredModelInput[];
  }): ManagedProviderDetails {
    return this.createProviderWithEndpointBundles({
      provider: input.provider,
      encryptedApiKey: input.encryptedApiKey,
      apiKeyHint: input.apiKeyHint,
      endpointBundles: [
        {
          endpoint: {
            endpointKey: "default",
            protocol: input.provider.adapterType === "anthropic" ? "anthropic" : "openai",
            adapterType: input.provider.adapterType,
            baseUrl: input.provider.baseUrl,
            enabled: input.provider.enabled ?? true,
            supportsStreaming: true,
            supportsTools: input.models.some((model) => model.supportsTools),
            supportsJsonMode: input.models.some((model) => model.supportsJsonMode)
          },
          models: input.models
        }
      ]
    });
  }

  public replaceProviderWithEndpointBundles(input: {
    providerKey: string;
    provider: ManagedProviderInput;
    encryptedApiKey?: string;
    apiKeyHint?: string;
    endpointBundles: ManagedEndpointBundleInput[];
  }): ManagedProviderDetails | null {
    const existing = this.getProviderDetails(input.providerKey);
    if (!existing) {
      return null;
    }

    const now = nowIso();
    const representativeEndpoint = input.endpointBundles[0]?.endpoint;

    return this.db.transaction((tx) => {
      tx.update(managedProvidersTable)
        .set({
          displayName: input.provider.displayName,
          adapterType: representativeEndpoint?.adapterType ?? input.provider.adapterType,
          baseUrl: representativeEndpoint?.baseUrl ?? input.provider.baseUrl,
          websiteUrl: input.provider.websiteUrl ?? null,
          enabled: input.provider.enabled ?? existing.provider.enabled,
          trustLevel: input.provider.trustLevel ?? existing.provider.trustLevel,
          privacyLevel: input.provider.privacyLevel ?? existing.provider.privacyLevel,
          usageTrust: input.provider.usageTrust ?? existing.provider.usageTrust,
          updatedAt: now
        })
        .where(eq(managedProvidersTable.providerKey, input.providerKey))
        .run();

      if (input.encryptedApiKey) {
        const currentCredential = tx.select().from(managedProviderCredentialsTable)
          .where(eq(managedProviderCredentialsTable.providerId, existing.provider.id))
          .get();

        if (currentCredential) {
          tx.update(managedProviderCredentialsTable)
            .set({
              apiKeyEncrypted: input.encryptedApiKey,
              keyHint: input.apiKeyHint ?? null,
              updatedAt: now
            })
            .where(eq(managedProviderCredentialsTable.providerId, existing.provider.id))
            .run();
        } else {
          tx.insert(managedProviderCredentialsTable).values({
            providerId: existing.provider.id,
            apiKeyEncrypted: input.encryptedApiKey,
            keyHint: input.apiKeyHint ?? null,
            createdAt: now,
            updatedAt: now
          }).run();
        }
      }

      tx.delete(managedModelsTable)
        .where(eq(managedModelsTable.providerId, existing.provider.id))
        .run();
      tx.delete(managedProviderEndpointsTable)
        .where(eq(managedProviderEndpointsTable.providerId, existing.provider.id))
        .run();

      let discoveredCount = 0;

      for (const bundle of input.endpointBundles) {
        const endpointInsert = tx.insert(managedProviderEndpointsTable)
          .values({
            providerId: existing.provider.id,
            endpointKey: bundle.endpoint.endpointKey,
            protocol: bundle.endpoint.protocol,
            adapterType: bundle.endpoint.adapterType,
            baseUrl: bundle.endpoint.baseUrl,
            enabled: bundle.endpoint.enabled ?? true,
            supportsStreaming: bundle.endpoint.supportsStreaming ?? true,
            supportsTools: bundle.endpoint.supportsTools ?? bundle.models.some((model) => model.supportsTools),
            supportsJsonMode: bundle.endpoint.supportsJsonMode ?? bundle.models.some((model) => model.supportsJsonMode),
            createdAt: now,
            updatedAt: now
          })
          .returning()
          .get();

        discoveredCount += bundle.models.length;

        if (bundle.models.length > 0) {
          tx.insert(managedModelsTable).values(
            bundle.models.map((model) => ({
              providerId: existing.provider.id,
              endpointId: endpointInsert.id,
              modelKey: model.modelKey,
              providerModelId: model.providerModelId,
              modelName: model.modelName,
              contextWindow: model.contextWindow,
              supportsStreaming: model.supportsStreaming,
              supportsTools: model.supportsTools,
              supportsJsonMode: model.supportsJsonMode,
              pricingJson: model.pricingJson ?? null,
              rawMetadataJson: model.rawMetadataJson ?? null,
              discoveredAt: now,
              updatedAt: now
            }))
          ).run();
        }
      }

      tx.insert(modelSyncRunsTable).values({
        providerId: existing.provider.id,
        status: "success",
        errorMessage: null,
        startedAt: now,
        finishedAt: now,
        discoveredCount
      }).run();

      return this.getProviderDetails(input.providerKey);
    });
  }

  public createProviderWithEndpointBundles(input: {
    provider: ManagedProviderInput;
    encryptedApiKey: string;
    apiKeyHint?: string;
    endpointBundles: ManagedEndpointBundleInput[];
  }): ManagedProviderDetails {
    const now = nowIso();

    return this.db.transaction((tx) => {
      const providerInsert = tx.insert(managedProvidersTable)
        .values({
          providerKey: input.provider.providerKey,
          displayName: input.provider.displayName,
          adapterType: input.provider.adapterType,
          baseUrl: input.provider.baseUrl,
          websiteUrl: input.provider.websiteUrl ?? null,
          enabled: input.provider.enabled ?? true,
          trustLevel: input.provider.trustLevel ?? "low",
          privacyLevel: input.provider.privacyLevel ?? "public_only",
          usageTrust: input.provider.usageTrust ?? "low",
          createdAt: now,
          updatedAt: now
        })
        .returning()
        .get();

      tx.insert(managedProviderCredentialsTable).values({
        providerId: providerInsert.id,
        apiKeyEncrypted: input.encryptedApiKey,
        keyHint: input.apiKeyHint ?? null,
        createdAt: now,
        updatedAt: now
        }).run();

      let discoveredCount = 0;

      for (const bundle of input.endpointBundles) {
        const endpointInsert = tx.insert(managedProviderEndpointsTable)
          .values({
            providerId: providerInsert.id,
            endpointKey: bundle.endpoint.endpointKey,
            protocol: bundle.endpoint.protocol,
            adapterType: bundle.endpoint.adapterType,
            baseUrl: bundle.endpoint.baseUrl,
            enabled: bundle.endpoint.enabled ?? true,
            supportsStreaming: bundle.endpoint.supportsStreaming ?? true,
            supportsTools: bundle.endpoint.supportsTools ?? bundle.models.some((model) => model.supportsTools),
            supportsJsonMode: bundle.endpoint.supportsJsonMode ?? bundle.models.some((model) => model.supportsJsonMode),
            createdAt: now,
            updatedAt: now
          })
          .returning()
          .get();

        discoveredCount += bundle.models.length;

        if (bundle.models.length > 0) {
          tx.insert(managedModelsTable).values(
            bundle.models.map((model) => ({
              providerId: providerInsert.id,
              endpointId: endpointInsert.id,
              modelKey: model.modelKey,
              providerModelId: model.providerModelId,
              modelName: model.modelName,
              contextWindow: model.contextWindow,
              supportsStreaming: model.supportsStreaming,
              supportsTools: model.supportsTools,
              supportsJsonMode: model.supportsJsonMode,
              pricingJson: model.pricingJson ?? null,
              rawMetadataJson: model.rawMetadataJson ?? null,
              discoveredAt: now,
              updatedAt: now
            }))
          ).run();
        }
      }

      tx.insert(modelSyncRunsTable).values({
        providerId: providerInsert.id,
        status: "success",
        errorMessage: null,
        startedAt: now,
        finishedAt: now,
        discoveredCount
      }).run();

      return this.getProviderDetails(providerInsert.providerKey)!;
    });
  }

  public syncProviderModels(providerKey: string, input: {
    endpointKey?: string;
    models: ManagedDiscoveredModelInput[];
    errorMessage?: string | null;
    status: "success" | "error";
  }): ManagedProviderDetails | null {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();

    if (!provider) {
      return null;
    }

    const endpoint = this.getProviderEndpoint(providerKey, input.endpointKey ?? "default");
    if (!endpoint) {
      return null;
    }

    const now = nowIso();

    this.db.transaction((tx) => {
      tx.insert(modelSyncRunsTable).values({
        providerId: provider.id,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
        startedAt: now,
        finishedAt: now,
        discoveredCount: input.models.length
      }).run();

      if (input.status !== "success") {
        return;
      }

      tx.delete(managedModelsTable)
        .where(and(
          eq(managedModelsTable.providerId, provider.id),
          eq(managedModelsTable.endpointId, endpoint.id)
        ))
        .run();

      if (input.models.length > 0) {
        tx.insert(managedModelsTable).values(
          input.models.map((model) => ({
            providerId: provider.id,
            endpointId: endpoint.id,
            modelKey: model.modelKey,
            providerModelId: model.providerModelId,
            modelName: model.modelName,
            contextWindow: model.contextWindow,
            supportsStreaming: model.supportsStreaming,
            supportsTools: model.supportsTools,
            supportsJsonMode: model.supportsJsonMode,
            pricingJson: model.pricingJson ?? null,
            rawMetadataJson: model.rawMetadataJson ?? null,
            discoveredAt: now,
            updatedAt: now
          }))
        ).run();
      }
    });

    return this.getProviderDetails(providerKey);
  }

  public listEnabledProviderBundles(): Array<{
    provider: ManagedProviderRow;
    credential: ManagedCredentialRow;
    endpoint: ManagedProviderEndpointRow;
    models: ManagedModelRow[];
  }> {
    const providers = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.enabled, true))
      .all();

    return providers.flatMap((provider) => {
      const credential = this.db.select().from(managedProviderCredentialsTable)
        .where(eq(managedProviderCredentialsTable.providerId, provider.id))
        .get();

      if (!credential) {
        return [];
      }

      const endpoints = this.db.select().from(managedProviderEndpointsTable)
        .where(and(
          eq(managedProviderEndpointsTable.providerId, provider.id),
          eq(managedProviderEndpointsTable.enabled, true)
        ))
        .all();
      const providerModels = this.db.select().from(managedModelsTable)
        .where(eq(managedModelsTable.providerId, provider.id))
        .all();

      return endpoints.map((endpoint) => {
        const endpointModels = providerModels
          .filter((model) => model.endpointId === endpoint.id);

        return {
          provider,
          credential,
          endpoint,
          models: endpointModels.length > 0 ? endpointModels : providerModels
        };
      });
    });
  }

  public updateProviderEnabled(providerKey: string, enabled: boolean): ManagedProviderDetails | null {
    return this.updateProvider(providerKey, { enabled });
  }

  public clearProviderEndpoints(providerKey: string): boolean {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();
    if (!provider) {
      return false;
    }

    this.db.transaction((tx) => {
      tx.delete(managedModelsTable)
        .where(eq(managedModelsTable.providerId, provider.id))
        .run();
      tx.delete(managedProviderEndpointsTable)
        .where(eq(managedProviderEndpointsTable.providerId, provider.id))
        .run();
    });

    return true;
  }

  public updateProvider(
    providerKey: string,
    input: ManagedProviderUpdateInput
  ): ManagedProviderDetails | null {
    const existing = this.getProviderDetails(providerKey);
    if (!existing) {
      return null;
    }

    const now = nowIso();
    this.db.update(managedProvidersTable)
      .set({
        displayName: input.displayName ?? existing.provider.displayName,
        baseUrl: input.baseUrl ?? existing.provider.baseUrl,
        websiteUrl:
          input.websiteUrl !== undefined ? input.websiteUrl : existing.provider.websiteUrl,
        enabled: input.enabled ?? existing.provider.enabled,
        updatedAt: now
      })
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .run();

    if (input.baseUrl !== undefined || input.protocol !== undefined || input.enabled !== undefined) {
      this.db.update(managedProviderEndpointsTable)
        .set({
          baseUrl: input.baseUrl ?? existing.provider.baseUrl,
          protocol: input.protocol ?? existing.endpoints.find((endpoint) => endpoint.endpointKey === "default")?.protocol ?? "openai",
          adapterType:
            input.protocol === "anthropic"
              ? "anthropic"
              : input.protocol === "openai"
                ? "openai_compatible"
                : existing.endpoints.find((endpoint) => endpoint.endpointKey === "default")?.adapterType ?? "openai_compatible",
          enabled: input.enabled ?? existing.provider.enabled,
          updatedAt: now
        })
        .where(and(
          eq(managedProviderEndpointsTable.providerId, existing.provider.id),
          eq(managedProviderEndpointsTable.endpointKey, "default")
        ))
        .run();
    }

    return this.getProviderDetails(providerKey);
  }

  public getProviderEndpoint(
    providerKey: string,
    endpointKey: string
  ): ManagedProviderEndpointRow | null {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();

    if (!provider) {
      return null;
    }

    return this.db.select().from(managedProviderEndpointsTable)
      .where(and(
        eq(managedProviderEndpointsTable.providerId, provider.id),
        eq(managedProviderEndpointsTable.endpointKey, endpointKey)
      ))
      .get() ?? null;
  }

  public createProviderEndpoint(
    providerKey: string,
    input: ManagedEndpointInput
  ): ManagedProviderEndpointRow | null {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();

    if (!provider) {
      return null;
    }

    const now = nowIso();
    return this.db.insert(managedProviderEndpointsTable)
      .values({
        providerId: provider.id,
        endpointKey: input.endpointKey,
        protocol: input.protocol,
        adapterType: input.adapterType,
        baseUrl: input.baseUrl,
        enabled: input.enabled ?? true,
        supportsStreaming: input.supportsStreaming ?? true,
        supportsTools: input.supportsTools ?? false,
        supportsJsonMode: input.supportsJsonMode ?? false,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .get();
  }

  public updateProviderEndpoint(
    providerKey: string,
    endpointKey: string,
    input: ManagedEndpointUpdateInput
  ): ManagedProviderDetails | null {
    const endpoint = this.getProviderEndpoint(providerKey, endpointKey);
    if (!endpoint) {
      return null;
    }

    this.db.update(managedProviderEndpointsTable)
      .set({
        protocol: input.protocol ?? endpoint.protocol,
        adapterType: input.adapterType ?? endpoint.adapterType,
        baseUrl: input.baseUrl ?? endpoint.baseUrl,
        enabled: input.enabled ?? endpoint.enabled,
        supportsStreaming: input.supportsStreaming ?? endpoint.supportsStreaming,
        supportsTools: input.supportsTools ?? endpoint.supportsTools,
        supportsJsonMode: input.supportsJsonMode ?? endpoint.supportsJsonMode,
        updatedAt: nowIso()
      })
      .where(eq(managedProviderEndpointsTable.id, endpoint.id))
      .run();

    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.id, endpoint.providerId))
      .get();

    return provider ? this.getProviderDetails(provider.providerKey) : null;
  }

  public updateModelCapabilities(
    providerKey: string,
    input: ManagedModelCapabilitiesUpdateInput
  ): ManagedProviderDetails | null {
    const existing = this.getProviderDetails(providerKey);
    if (!existing) {
      return null;
    }

    const model = existing.models.find((item) => item.modelKey === input.modelKey);
    if (!model) {
      return null;
    }

    const now = nowIso();
    this.db.update(managedModelsTable)
      .set({
        supportsStreaming: input.supportsStreaming ?? model.supportsStreaming,
        supportsTools: input.supportsTools ?? model.supportsTools,
        supportsJsonMode: input.supportsJsonMode ?? model.supportsJsonMode,
        updatedAt: now
      })
      .where(and(
        eq(managedModelsTable.providerId, existing.provider.id),
        eq(managedModelsTable.modelKey, input.modelKey)
      ))
      .run();

    return this.getProviderDetails(providerKey);
  }

  public deleteProvider(providerKey: string): boolean {
    const result = this.db.delete(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .run();

    return result.changes > 0;
  }

  public updateCredential(providerKey: string, encryptedApiKey: string, apiKeyHint: string): boolean {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();

    if (!provider) {
      return false;
    }

    const now = nowIso();
    const existing = this.db.select().from(managedProviderCredentialsTable)
      .where(eq(managedProviderCredentialsTable.providerId, provider.id))
      .get();

    if (existing) {
      this.db.update(managedProviderCredentialsTable)
        .set({
          apiKeyEncrypted: encryptedApiKey,
          keyHint: apiKeyHint,
          updatedAt: now
        })
        .where(eq(managedProviderCredentialsTable.providerId, provider.id))
        .run();
      return true;
    }

    this.db.insert(managedProviderCredentialsTable).values({
      providerId: provider.id,
      apiKeyEncrypted: encryptedApiKey,
      keyHint: apiKeyHint,
      createdAt: now,
      updatedAt: now
    }).run();

    return true;
  }

  public static toApiKeyHint(apiKey: string): string {
    return keyHintFromApiKey(apiKey);
  }
}
