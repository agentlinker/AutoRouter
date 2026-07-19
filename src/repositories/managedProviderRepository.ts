import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq } from "drizzle-orm";

import {
  managedModelsTable,
  managedProviderCredentialsTable,
  managedProvidersTable,
  modelSyncRunsTable,
  type ManagedCredentialRow,
  type ManagedModelRow,
  type ManagedProviderRow,
  type ModelSyncRunRow,
  type schema
} from "../db/schema.js";

export interface ManagedProviderInput {
  providerKey: string;
  displayName: string;
  adapterType: "openai_compatible";
  baseUrl: string;
  websiteUrl?: string | null;
  enabled?: boolean;
  trustLevel?: "low" | "medium" | "high";
  privacyLevel?: "public_only" | "normal" | "private";
  usageTrust?: "low" | "medium" | "high";
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
  baseUrl?: string;
  websiteUrl?: string | null;
  enabled?: boolean;
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

    const models = this.db.select().from(managedModelsTable)
      .where(eq(managedModelsTable.providerId, provider.id))
      .all();

    const latestSync = this.db.select().from(modelSyncRunsTable)
      .where(eq(modelSyncRunsTable.providerId, provider.id))
      .orderBy(desc(modelSyncRunsTable.startedAt))
      .limit(1)
      .get() ?? null;

    return { provider, credential, models, latestSync };
  }

  public createProviderWithModels(input: {
    provider: ManagedProviderInput;
    encryptedApiKey: string;
    apiKeyHint?: string;
    models: ManagedDiscoveredModelInput[];
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

      if (input.models.length > 0) {
        tx.insert(managedModelsTable).values(
          input.models.map((model) => ({
            providerId: providerInsert.id,
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

      tx.insert(modelSyncRunsTable).values({
        providerId: providerInsert.id,
        status: "success",
        errorMessage: null,
        startedAt: now,
        finishedAt: now,
        discoveredCount: input.models.length
      }).run();

      return this.getProviderDetails(providerInsert.providerKey)!;
    });
  }

  public syncProviderModels(providerKey: string, input: {
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
        .where(eq(managedModelsTable.providerId, provider.id))
        .run();

      if (input.models.length > 0) {
        tx.insert(managedModelsTable).values(
          input.models.map((model) => ({
            providerId: provider.id,
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

      const models = this.db.select().from(managedModelsTable)
        .where(eq(managedModelsTable.providerId, provider.id))
        .all();

      return [{ provider, credential, models }];
    });
  }

  public updateProviderEnabled(providerKey: string, enabled: boolean): ManagedProviderDetails | null {
    return this.updateProvider(providerKey, { enabled });
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

    return this.getProviderDetails(providerKey);
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
