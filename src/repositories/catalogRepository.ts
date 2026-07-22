import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";

import {
  logicalModelsTable,
  managedModelsTable,
  managedProviderEndpointsTable,
  managedProvidersTable,
  type LogicalModelRow,
  type ManagedModelRow,
  type ManagedProviderEndpointRow,
  type ManagedProviderRow,
  type schema
} from "../db/schema.js";
import { displayNameFromLogicalName, mergeAliases, toLogicalModelName } from "../catalog/logicalModelNames.js";
import type { OpenRouterModelMetadata } from "../discovery/openrouterModelMetadata.js";

type Db = BetterSQLite3Database<typeof schema>;

function nowIso(): string {
  return new Date().toISOString();
}

export interface CatalogModelInstance {
  model: ManagedModelRow;
  provider: ManagedProviderRow;
  endpoint: ManagedProviderEndpointRow | null;
}

export interface CatalogLogicalModelDetails {
  logical: LogicalModelRow;
  instances: CatalogModelInstance[];
}

export interface LogicalModelUpdateInput {
  displayName?: string | null;
  openrouterSlug?: string | null;
  aliasesJson?: string | null;
  contextWindow?: number | null;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonMode?: boolean;
  inputModalitiesJson?: string | null;
  pricingJson?: string | null;
  notes?: string | null;
  metadataSource?: string;
  metadataConfidence?: string;
}

export interface ManagedModelOverrideUpdateInput {
  enabled?: boolean;
  contextWindowOverride?: number | null;
  supportsStreamingOverride?: boolean | null;
  supportsToolsOverride?: boolean | null;
  supportsJsonModeOverride?: boolean | null;
  pricingJsonOverride?: string | null;
}

export class CatalogRepository {
  public constructor(private readonly db: Db) {}

  public ensureLogicalModel(logicalNameInput: string): LogicalModelRow {
    const logicalName = toLogicalModelName(logicalNameInput);
    const aliasesJson = mergeAliases(logicalNameInput);
    const existing = this.db.select().from(logicalModelsTable)
      .where(eq(logicalModelsTable.logicalName, logicalName))
      .get();
    if (existing) {
      const mergedAliases = mergeAliases(
        ...(existing.aliasesJson ? JSON.parse(existing.aliasesJson) as string[] : []),
        logicalNameInput
      );
      if (mergedAliases !== existing.aliasesJson) {
        this.db.update(logicalModelsTable)
          .set({
            aliasesJson: mergedAliases,
            updatedAt: nowIso()
          })
          .where(eq(logicalModelsTable.id, existing.id))
          .run();
      }
      return existing;
    }

    const now = nowIso();
    return this.db.insert(logicalModelsTable).values({
      logicalName,
      displayName: displayNameFromLogicalName(logicalName),
      aliasesJson,
      supportsStreaming: true,
      supportsTools: true,
      supportsJsonMode: false,
      metadataSource: "provider_derived",
      metadataConfidence: "low",
      createdAt: now,
      updatedAt: now
    }).returning().get();
  }

  public listLogicalModels(): CatalogLogicalModelDetails[] {
    const logicalModels = this.db.select().from(logicalModelsTable).all()
      .sort((left, right) => left.logicalName.localeCompare(right.logicalName));
    return logicalModels.map((logical) => ({
      logical,
      instances: this.listInstancesForLogicalId(logical.id)
    }));
  }

  public getLogicalModel(logicalName: string): CatalogLogicalModelDetails | null {
    const logical = this.db.select().from(logicalModelsTable)
      .where(eq(logicalModelsTable.logicalName, logicalName))
      .get();
    if (!logical) {
      return null;
    }

    return {
      logical,
      instances: this.listInstancesForLogicalId(logical.id)
    };
  }

  public listLogicalModelsByIds(ids: number[]): Map<number, LogicalModelRow> {
    if (ids.length === 0) {
      return new Map();
    }

    const rows = this.db.select().from(logicalModelsTable).all()
      .filter((row) => ids.includes(row.id));
    return new Map(rows.map((row) => [row.id, row]));
  }

  public updateLogicalModel(
    logicalName: string,
    input: LogicalModelUpdateInput
  ): CatalogLogicalModelDetails | null {
    const existing = this.db.select().from(logicalModelsTable)
      .where(eq(logicalModelsTable.logicalName, logicalName))
      .get();
    if (!existing) {
      return null;
    }

    this.db.update(logicalModelsTable)
      .set({
        displayName: input.displayName !== undefined ? input.displayName : existing.displayName,
        openrouterSlug:
          input.openrouterSlug !== undefined ? input.openrouterSlug : existing.openrouterSlug,
        aliasesJson: input.aliasesJson !== undefined ? input.aliasesJson : existing.aliasesJson,
        contextWindow:
          input.contextWindow !== undefined ? input.contextWindow : existing.contextWindow,
        supportsStreaming:
          input.supportsStreaming !== undefined ? input.supportsStreaming : existing.supportsStreaming,
        supportsTools:
          input.supportsTools !== undefined ? input.supportsTools : existing.supportsTools,
        supportsJsonMode:
          input.supportsJsonMode !== undefined ? input.supportsJsonMode : existing.supportsJsonMode,
        inputModalitiesJson:
          input.inputModalitiesJson !== undefined
            ? input.inputModalitiesJson
            : existing.inputModalitiesJson,
        pricingJson: input.pricingJson !== undefined ? input.pricingJson : existing.pricingJson,
        metadataSource:
          input.metadataSource !== undefined ? input.metadataSource : existing.metadataSource,
        metadataConfidence:
          input.metadataConfidence !== undefined
            ? input.metadataConfidence
            : existing.metadataConfidence,
        notes: input.notes !== undefined ? input.notes : existing.notes,
        updatedAt: nowIso()
      })
      .where(eq(logicalModelsTable.id, existing.id))
      .run();

    return this.getLogicalModel(logicalName);
  }

  public updateManagedModelOverrides(
    providerKey: string,
    modelKey: string,
    input: ManagedModelOverrideUpdateInput
  ): CatalogLogicalModelDetails | null {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();
    if (!provider) {
      return null;
    }

    const model = this.db.select().from(managedModelsTable)
      .where(and(
        eq(managedModelsTable.providerId, provider.id),
        eq(managedModelsTable.modelKey, modelKey)
      ))
      .get();
    if (!model) {
      return null;
    }

    const manualOverride = {
      ...(model.manualOverrideJson ? JSON.parse(model.manualOverrideJson) as Record<string, unknown> : {}),
      ...(input.contextWindowOverride !== undefined ? { context_window: true } : {}),
      ...(input.supportsStreamingOverride !== undefined ? { supports_streaming: true } : {}),
      ...(input.supportsToolsOverride !== undefined ? { supports_tools: true } : {}),
      ...(input.supportsJsonModeOverride !== undefined ? { supports_json_mode: true } : {}),
      ...(input.pricingJsonOverride !== undefined ? { pricing: true } : {}),
      ...(input.enabled !== undefined ? { enabled: true } : {})
    };

    this.db.update(managedModelsTable)
      .set({
        enabled: input.enabled !== undefined ? input.enabled : model.enabled,
        contextWindowOverride:
          input.contextWindowOverride !== undefined
            ? input.contextWindowOverride
            : model.contextWindowOverride,
        supportsStreamingOverride:
          input.supportsStreamingOverride !== undefined
            ? input.supportsStreamingOverride
            : model.supportsStreamingOverride,
        supportsToolsOverride:
          input.supportsToolsOverride !== undefined
            ? input.supportsToolsOverride
            : model.supportsToolsOverride,
        supportsJsonModeOverride:
          input.supportsJsonModeOverride !== undefined
            ? input.supportsJsonModeOverride
            : model.supportsJsonModeOverride,
        pricingJsonOverride:
          input.pricingJsonOverride !== undefined
            ? input.pricingJsonOverride
            : model.pricingJsonOverride,
        manualOverrideJson: JSON.stringify(manualOverride),
        updatedAt: nowIso()
      })
      .where(eq(managedModelsTable.id, model.id))
      .run();

    const logicalId = model.logicalModelId;
    if (!logicalId) {
      return null;
    }

    const logical = this.db.select().from(logicalModelsTable)
      .where(eq(logicalModelsTable.id, logicalId))
      .get();
    return logical ? this.getLogicalModel(logical.logicalName) : null;
  }

  public enrichLogicalModelFromOpenRouter(
    logicalName: string,
    metadata: OpenRouterModelMetadata
  ): CatalogLogicalModelDetails | null {
    const existing = this.db.select().from(logicalModelsTable)
      .where(eq(logicalModelsTable.logicalName, logicalName))
      .get();
    if (!existing) {
      return null;
    }

    const now = nowIso();
    this.db.update(logicalModelsTable)
      .set({
        displayName: existing.displayName ?? metadata.name ?? existing.logicalName,
        openrouterSlug: metadata.id,
        contextWindow: metadata.contextLength ?? existing.contextWindow,
        supportsTools: metadata.supportsTools ?? existing.supportsTools,
        inputModalitiesJson: metadata.inputModalities
          ? JSON.stringify(metadata.inputModalities)
          : existing.inputModalitiesJson,
        pricingJson: metadata.pricing ? JSON.stringify(metadata.pricing) : existing.pricingJson,
        rawMetadataJson: JSON.stringify(metadata.raw),
        metadataSource: "openrouter",
        metadataConfidence: "high",
        fetchedAt: now,
        updatedAt: now
      })
      .where(eq(logicalModelsTable.id, existing.id))
      .run();

    return this.getLogicalModel(logicalName);
  }

  private listInstancesForLogicalId(logicalModelId: number): CatalogModelInstance[] {
    const models = this.db.select().from(managedModelsTable)
      .where(eq(managedModelsTable.logicalModelId, logicalModelId))
      .all()
      .sort((left, right) => left.modelKey.localeCompare(right.modelKey));
    const providers = new Map(
      this.db.select().from(managedProvidersTable).all().map((provider) => [provider.id, provider])
    );
    const endpoints = new Map(
      this.db.select().from(managedProviderEndpointsTable).all().map((endpoint) => [endpoint.id, endpoint])
    );

    return models.flatMap((model) => {
      const provider = providers.get(model.providerId);
      if (!provider) {
        return [];
      }

      return [{
        model,
        provider,
        endpoint: model.endpointId ? endpoints.get(model.endpointId) ?? null : null
      }];
    });
  }
}
