import type { WireProtocol } from "../config/schema.js";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import {
  managedAccountEndpointModelsTable,
  managedAccountEndpointsTable,
  logicalModelsTable,
  managedAccountModelsTable,
  managedModelsTable,
  managedProviderCredentialsTable,
  managedProviderEndpointsTable,
  managedProvidersTable,
  modelSyncRunsTable,
  type ManagedAccountEndpointModelRow,
  type ManagedAccountEndpointRow,
  type ManagedAccountModelRow,
  type ManagedCredentialRow,
  type ManagedModelRow,
  type ManagedProviderEndpointRow,
  type ManagedProviderRow,
  type ModelSyncRunRow,
  type schema
} from "../db/schema.js";
import { displayNameFromLogicalName, mergeAliases, toLogicalModelName } from "../catalog/logicalModelNames.js";
import { accountUnavailableReason, isRuntimeStatusValue } from "../runtime/runtimeStatus.js";

export type ProviderKind = "official" | "relay" | "custom";

export interface ManagedProviderInput {
  providerKey: string;
  displayName: string;
  protocol?: WireProtocol;
  baseUrl: string;
  websiteUrl?: string | null;
  modelCatalogUrl?: string | null;
  providerKind?: ProviderKind;
  enabled?: boolean;
  priority?: number;
  trustLevel?: "low" | "medium" | "high";
  privacyLevel?: "public_only" | "normal" | "private";
  usageTrust?: "low" | "medium" | "high";
}

export interface ManagedAccountInput {
  accountKey: string;
  encryptedApiKey: string;
  apiKeyHint?: string | null;
  enabled?: boolean;
  expiresAt?: string | null;
  quotaJson?: string | null;
  remark?: string | null;
}

export interface ManagedAccountUpdateInput {
  encryptedApiKey?: string;
  apiKeyHint?: string | null;
  enabled?: boolean;
  expiresAt?: string | null;
  quotaJson?: string | null;
  remark?: string | null;
}

export interface AccountQuota {
  monthly_usd_limit?: number;
  remaining_usd?: number;
  remaining_requests?: number;
  reset_at?: string;
  source?: "manual" | "discovered" | "unknown";
}

export interface ManagedEndpointInput {
  endpointKey: string;
  protocol: WireProtocol;
  baseUrl: string;
  customHeaders?: Record<string, string>;
  enabled?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonMode?: boolean;
}

export interface ManagedEndpointSetInput {
  protocol: WireProtocol;
  baseUrl: string;
}

export type ManagedEndpointSetRelation =
  | "exact"
  | "candidate_subset"
  | "existing_subset"
  | "conflict";

export interface ManagedProviderEndpointSetCandidate {
  provider: ManagedProviderRow;
  relation: ManagedEndpointSetRelation;
  matchingEndpoints: ManagedProviderEndpointRow[];
  conflictingEndpoints: Array<{
    protocol: WireProtocol;
    candidateBaseUrl: string;
    existingBaseUrl: string;
  }>;
  candidateOnlyEndpoints: ManagedEndpointSetInput[];
  existingOnlyEndpoints: ManagedProviderEndpointRow[];
}

export interface ManagedEndpointBundleInput {
  endpoint: ManagedEndpointInput;
  models: ManagedDiscoveredModelInput[];
}

export interface ManagedInitialModelSync {
  status: "success" | "error";
  catalogUrl?: string | null;
  errorMessage?: string | null;
  discoveredCount: number;
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
  websiteUrl?: string | null;
  modelCatalogUrl?: string | null;
  providerKind?: ProviderKind;
  enabled?: boolean;
  priority?: number;
}

function normalizeProviderPriority(priority: number | undefined): number | undefined {
  if (priority === undefined || !Number.isFinite(priority)) {
    return undefined;
  }
  return Math.trunc(priority);
}

function isManualModel(model: Pick<ManagedModelRow, "rawMetadataJson">): boolean {
  if (!model.rawMetadataJson) {
    return false;
  }
  try {
    const metadata = JSON.parse(model.rawMetadataJson) as { source?: unknown };
    return metadata.source === "manual";
  } catch {
    return false;
  }
}

export interface ManagedEndpointUpdateInput {
  protocol?: WireProtocol;
  baseUrl?: string;
  customHeaders?: Record<string, string>;
  enabled?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonMode?: boolean;
}

export interface ManagedModelCapabilitiesUpdateInput {
  modelKey: string;
  enabled?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonMode?: boolean;
}

export interface ManagedProviderDetails {
  provider: ManagedProviderRow;
  /** @deprecated use accounts; first/default account for backward compatibility */
  credential: ManagedCredentialRow | null;
  accounts: ManagedCredentialRow[];
  accountModels: Array<{
    accountId: number;
    models: ManagedModelRow[];
  }>;
  accountEndpointModels: ManagedAccountEndpointModelRow[];
  accountEndpoints: ManagedAccountEndpointRow[];
  endpoints: ManagedProviderEndpointRow[];
  models: ManagedModelRow[];
  latestSync: ModelSyncRunRow | null;
}

export type ProviderListSortBy = "priority" | "created_at" | "updated_at";
export type SortDirection = "asc" | "desc";

export interface ListProviderSummariesOptions {
  sortBy?: ProviderListSortBy;
  sortDir?: SortDirection;
  page?: number;
  pageSize?: number;
}

export interface ListProviderSummariesResult {
  items: ManagedProviderDetails[];
  total: number;
  availableTotal: number;
  page: number;
  pageSize: number;
  sortBy: ProviderListSortBy;
  sortDir: SortDirection;
}

type Db = BetterSQLite3Database<typeof schema>;
const MANAGED_MODEL_INSERT_BATCH_SIZE = 100;
type ModelPreservedFields = Pick<
  ManagedModelRow,
  | "enabled"
  | "runtimeStatus"
  | "statusReason"
  | "statusMessage"
  | "statusSource"
  | "statusUpdatedAt"
  | "statusCooldownUntil"
  | "rateLimitStrike"
  | "recentErrorCount"
  | "lastErrorAt"
  | "lastErrorCode"
  | "lastErrorMessage"
  | "contextWindowOverride"
  | "supportsToolsOverride"
  | "supportsStreamingOverride"
  | "supportsJsonModeOverride"
  | "pricingJsonOverride"
  | "manualOverrideJson"
>;

function nowIso(): string {
  return new Date().toISOString();
}

function keyHintFromApiKey(apiKey: string): string {
  const suffix = apiKey.slice(-4);
  return suffix ? `...${suffix}` : "hidden";
}

function defaultProviderKind(kind?: ProviderKind): ProviderKind {
  return kind ?? "custom";
}

export function parseAccountQuota(quotaJson: string | null | undefined): AccountQuota | undefined {
  if (!quotaJson) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(quotaJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const quota: AccountQuota = {};
    if (typeof record.monthly_usd_limit === "number") {
      quota.monthly_usd_limit = record.monthly_usd_limit;
    }
    if (typeof record.remaining_usd === "number") {
      quota.remaining_usd = record.remaining_usd;
    }
    if (typeof record.remaining_requests === "number") {
      quota.remaining_requests = record.remaining_requests;
    }
    if (typeof record.reset_at === "string") {
      quota.reset_at = record.reset_at;
    }
    if (
      record.source === "manual" ||
      record.source === "discovered" ||
      record.source === "unknown"
    ) {
      quota.source = record.source;
    }
    return Object.keys(quota).length > 0 ? quota : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeBaseUrlForMerge(baseUrl: string): string {
  try {
    const url = new URL(baseUrl.trim());
    url.hash = "";
    url.search = "";
    const pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
  } catch {
    return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "").toLowerCase();
  }
}

function endpointSetRelation(input: {
  conflictingCount: number;
  candidateOnlyCount: number;
  existingOnlyCount: number;
}): ManagedEndpointSetRelation {
  if (
    input.conflictingCount > 0 ||
    (input.candidateOnlyCount > 0 && input.existingOnlyCount > 0)
  ) {
    return "conflict";
  }
  if (input.candidateOnlyCount > 0) {
    return "existing_subset";
  }
  if (input.existingOnlyCount > 0) {
    return "candidate_subset";
  }
  return "exact";
}

function classifyProviderEndpointSet(
  provider: ManagedProviderRow,
  providerEndpoints: ManagedProviderEndpointRow[],
  inputs: ManagedEndpointSetInput[]
): ManagedProviderEndpointSetCandidate | null {
  const candidateProtocols = new Set(inputs.map((input) => input.protocol));
  const existingByProtocol = new Map(
    providerEndpoints.map((endpoint) => [endpoint.protocol, endpoint])
  );
  const matchingEndpoints: ManagedProviderEndpointRow[] = [];
  const conflictingEndpoints: ManagedProviderEndpointSetCandidate["conflictingEndpoints"] = [];
  const candidateOnlyEndpoints: ManagedEndpointSetInput[] = [];

  for (const input of inputs) {
    const existing = existingByProtocol.get(input.protocol);
    if (!existing) {
      candidateOnlyEndpoints.push(input);
    } else if (
      normalizeBaseUrlForMerge(existing.baseUrl) ===
      normalizeBaseUrlForMerge(input.baseUrl)
    ) {
      matchingEndpoints.push(existing);
    } else {
      conflictingEndpoints.push({
        protocol: input.protocol,
        candidateBaseUrl: input.baseUrl,
        existingBaseUrl: existing.baseUrl
      });
    }
  }

  if (matchingEndpoints.length === 0) {
    return null;
  }

  const existingOnlyEndpoints = providerEndpoints.filter(
    (endpoint) => !candidateProtocols.has(endpoint.protocol as WireProtocol)
  );
  return {
    provider,
    relation: endpointSetRelation({
      conflictingCount: conflictingEndpoints.length,
      candidateOnlyCount: candidateOnlyEndpoints.length,
      existingOnlyCount: existingOnlyEndpoints.length
    }),
    matchingEndpoints,
    conflictingEndpoints,
    candidateOnlyEndpoints,
    existingOnlyEndpoints
  };
}

export class ManagedProviderRepository {
  public constructor(private readonly db: Db) {}

  public getDatabase(): Db {
    return this.db;
  }

  private ensureLogicalModelForProviderModel(db: Db, input: {
    providerModelId: string;
    modelName: string;
  }) {
    const logicalName = toLogicalModelName(input.providerModelId);
    const aliasesJson = mergeAliases(input.providerModelId, input.modelName);
    const existing = db.select().from(logicalModelsTable)
      .where(eq(logicalModelsTable.logicalName, logicalName))
      .get();
    if (existing) {
      const mergedAliases = mergeAliases(
        ...(existing.aliasesJson ? JSON.parse(existing.aliasesJson) as string[] : []),
        input.providerModelId,
        input.modelName
      );
      if (mergedAliases !== existing.aliasesJson) {
        db.update(logicalModelsTable)
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
    return db.insert(logicalModelsTable).values({
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

  private buildManagedModelInsert(input: {
    db: Db;
    providerId: number;
    model: ManagedDiscoveredModelInput;
    now: string;
    preserved?: Partial<ModelPreservedFields>;
  }) {
    const logical = this.ensureLogicalModelForProviderModel(input.db, {
      providerModelId: input.model.providerModelId,
      modelName: input.model.modelName
    });
    if (logical.metadataSource === "provider_derived") {
      input.db.update(logicalModelsTable)
        .set({
          contextWindow: logical.contextWindow ?? input.model.contextWindow ?? null,
          supportsStreaming: logical.supportsStreaming || input.model.supportsStreaming,
          supportsTools: logical.supportsTools || input.model.supportsTools,
          supportsJsonMode: logical.supportsJsonMode || input.model.supportsJsonMode,
          pricingJson: logical.pricingJson ?? input.model.pricingJson ?? null,
          updatedAt: input.now
        })
        .where(eq(logicalModelsTable.id, logical.id))
        .run();
    }

    return {
      providerId: input.providerId,
      logicalModelId: logical.id,
      modelKey: input.model.modelKey,
      providerModelId: input.model.providerModelId,
      modelName: input.model.modelName,
      contextWindow: input.model.contextWindow,
      supportsStreaming: input.model.supportsStreaming,
      supportsTools: input.model.supportsTools,
      supportsJsonMode: input.model.supportsJsonMode,
      pricingJson: input.model.pricingJson ?? null,
      rawMetadataJson: input.model.rawMetadataJson ?? null,
      enabled: input.preserved?.enabled ?? true,
      runtimeStatus: input.preserved?.runtimeStatus ?? "normal",
      statusReason: input.preserved?.statusReason ?? null,
      statusMessage: input.preserved?.statusMessage ?? null,
      statusSource: input.preserved?.statusSource ?? "system",
      statusUpdatedAt: input.preserved?.statusUpdatedAt ?? null,
      statusCooldownUntil: input.preserved?.statusCooldownUntil ?? null,
      rateLimitStrike: input.preserved?.rateLimitStrike ?? 0,
      recentErrorCount: input.preserved?.recentErrorCount ?? 0,
      lastErrorAt: input.preserved?.lastErrorAt ?? null,
      lastErrorCode: input.preserved?.lastErrorCode ?? null,
      lastErrorMessage: input.preserved?.lastErrorMessage ?? null,
      contextWindowOverride: input.preserved?.contextWindowOverride ?? null,
      supportsToolsOverride: input.preserved?.supportsToolsOverride ?? null,
      supportsStreamingOverride: input.preserved?.supportsStreamingOverride ?? null,
      supportsJsonModeOverride: input.preserved?.supportsJsonModeOverride ?? null,
      pricingJsonOverride: input.preserved?.pricingJsonOverride ?? null,
      manualOverrideJson: input.preserved?.manualOverrideJson ?? null,
      discoveredAt: input.now,
      updatedAt: input.now
    };
  }

  private insertManagedModels(
    db: Db,
    rows: Array<ReturnType<ManagedProviderRepository["buildManagedModelInsert"]>>
  ): void {
    for (let offset = 0; offset < rows.length; offset += MANAGED_MODEL_INSERT_BATCH_SIZE) {
      db.insert(managedModelsTable)
        .values(rows.slice(offset, offset + MANAGED_MODEL_INSERT_BATCH_SIZE))
        .run();
    }
  }

  private preservedFieldsByModelKey(models: ManagedModelRow[]): Map<string, ModelPreservedFields> {
    return new Map(models.map((model) => [
      model.modelKey,
      {
        enabled: model.enabled,
        runtimeStatus: model.runtimeStatus,
        statusReason: model.statusReason,
        statusMessage: model.statusMessage,
        statusSource: model.statusSource,
        statusUpdatedAt: model.statusUpdatedAt,
        statusCooldownUntil: model.statusCooldownUntil,
        rateLimitStrike: model.rateLimitStrike,
        recentErrorCount: model.recentErrorCount,
        lastErrorAt: model.lastErrorAt,
        lastErrorCode: model.lastErrorCode,
        lastErrorMessage: model.lastErrorMessage,
        contextWindowOverride: model.contextWindowOverride,
        supportsToolsOverride: model.supportsToolsOverride,
        supportsStreamingOverride: model.supportsStreamingOverride,
        supportsJsonModeOverride: model.supportsJsonModeOverride,
        pricingJsonOverride: model.pricingJsonOverride,
        manualOverrideJson: model.manualOverrideJson
      }
    ]));
  }


  private listAccountModelIds(accountId: number): Set<number> {
    return new Set(this.listAccountModelRows(accountId).map((row) => row.managedModelId));
  }

  private listAccountModelRows(accountId: number): ManagedAccountModelRow[] {
    return this.db.select().from(managedAccountModelsTable)
      .where(and(
        eq(managedAccountModelsTable.accountId, accountId),
        eq(managedAccountModelsTable.enabled, true)
      ))
      .all();
  }

  private replaceAccountModelLinks(
    db: Db,
    accountId: number,
    modelIds: number[],
    now: string
  ) {
    db.update(managedAccountModelsTable)
      .set({ enabled: false })
      .where(eq(managedAccountModelsTable.accountId, accountId))
      .run();

    this.upsertAccountModelLinks(db, accountId, modelIds, now);
  }

  private upsertAccountModelLinks(
    db: Db,
    accountId: number,
    modelIds: number[],
    now: string
  ) {
    for (const managedModelId of modelIds) {
      const existing = db.select().from(managedAccountModelsTable)
        .where(and(
          eq(managedAccountModelsTable.accountId, accountId),
          eq(managedAccountModelsTable.managedModelId, managedModelId)
        ))
        .get();
      if (existing) {
        db.update(managedAccountModelsTable)
          .set({
            enabled: true,
            lastSeenAt: now
          })
          .where(eq(managedAccountModelsTable.id, existing.id))
          .run();
      } else {
        db.insert(managedAccountModelsTable).values({
          accountId,
          managedModelId,
          enabled: true,
          discoveredAt: now,
          lastSeenAt: now
        }).run();
      }
    }
  }

  public listAvailableAccountKeysForModel(
    providerId: number,
    managedModelId: number
  ): string[] {
    const rows = this.db.select().from(managedAccountModelsTable)
      .where(and(
        eq(managedAccountModelsTable.managedModelId, managedModelId),
        eq(managedAccountModelsTable.enabled, true)
      ))
      .all();
    if (rows.length === 0) {
      return [];
    }
    const accountIds = new Set(rows.map((row) => row.accountId));
    const accounts = this.db.select().from(managedProviderCredentialsTable)
      .where(eq(managedProviderCredentialsTable.providerId, providerId))
      .all()
      .filter((account) => accountIds.has(account.id) && account.enabled !== false);
    return accounts.map((account) => account.accountKey);
  }

  public listProviderSummaries(): ManagedProviderDetails[] {
    return this.listProviderSummariesPage().items;
  }

  public listProviderSummariesPage(
    options: ListProviderSummariesOptions = {}
  ): ListProviderSummariesResult {
    const sortBy = options.sortBy ?? "priority";
    const sortDir = options.sortDir ?? "desc";
    const page = Math.max(1, Math.floor(options.page ?? 1));
    const pageSize = Math.max(1, Math.min(200, Math.floor(options.pageSize ?? 50)));
    const primaryColumn =
      sortBy === "created_at"
        ? managedProvidersTable.createdAt
        : sortBy === "updated_at"
          ? managedProvidersTable.updatedAt
          : managedProvidersTable.priority;
    const primaryOrder = sortDir === "asc" ? asc(primaryColumn) : desc(primaryColumn);
    const secondaryOrders =
      sortBy === "priority"
        ? [desc(managedProvidersTable.updatedAt), asc(managedProvidersTable.providerKey)]
        : sortBy === "updated_at"
          ? [desc(managedProvidersTable.priority), asc(managedProvidersTable.providerKey)]
        : [
            desc(managedProvidersTable.priority),
            desc(managedProvidersTable.updatedAt),
            asc(managedProvidersTable.providerKey)
          ];
    const providers = this.db.select().from(managedProvidersTable)
      .orderBy(primaryOrder, ...secondaryOrders)
      .all();
    const total = providers.length;
    const availableTotal = this.countAvailableProviders();
    const offset = (page - 1) * pageSize;
    const pageProviders = providers.slice(offset, offset + pageSize);
    const items = pageProviders.map((provider) => this.getProviderDetails(provider.providerKey)).filter(
      (item): item is ManagedProviderDetails => item !== null
    );
    return {
      items,
      total,
      availableTotal,
      page,
      pageSize,
      sortBy,
      sortDir
    };
  }

  /**
   * Count providers that can form at least one complete route candidate.
   * This is deliberately one aggregate query so pagination does not load every provider bundle.
   */
  private countAvailableProviders(now = new Date()): number {
    const nowValue = now.toISOString();
    const row = this.db
      .select({
        count: sql<number>`count(*)`
      })
      .from(managedProvidersTable)
      .where(sql`
        ${managedProvidersTable.enabled} = 1
        AND EXISTS (
          SELECT 1
          FROM managed_provider_endpoints AS endpoint
          INNER JOIN managed_provider_credentials AS account
            ON account.provider_id = ${managedProvidersTable.id}
           AND account.enabled = 1
          INNER JOIN managed_models AS model
            ON model.provider_id = ${managedProvidersTable.id}
           AND model.enabled = 1
          WHERE endpoint.provider_id = ${managedProvidersTable.id}
            AND endpoint.enabled = 1
            -- 到期时间只用于排序，不作为过滤条件
            AND CASE
              WHEN account.quota_json IS NULL OR json_valid(account.quota_json) = 0 THEN 1
              WHEN json_type(account.quota_json, '$.remaining_usd') IN ('integer', 'real')
                THEN CAST(json_extract(account.quota_json, '$.remaining_usd') AS REAL) > 0
              ELSE 1
            END
            AND account.runtime_status NOT IN ('disabled', 'abnormal')
            AND NOT (
              account.runtime_status = 'cooling_down'
              AND (
                coalesce(account.status_reason, '') GLOB '*_permanent'
                OR (
                  account.status_cooldown_until IS NOT NULL
                  AND account.status_cooldown_until > ${nowValue}
                )
              )
            )
            AND NOT (
              account.runtime_status = 'rate_limited'
              AND (
                account.status_reason = 'rate_limited_permanent'
                OR (
                  account.status_cooldown_until IS NOT NULL
                  AND account.status_cooldown_until > ${nowValue}
                )
              )
            )
            AND EXISTS (
              SELECT 1
              FROM managed_account_models AS account_model
              WHERE account_model.account_id = account.id
                AND account_model.managed_model_id = model.id
                AND account_model.enabled = 1
                AND account_model.runtime_status NOT IN ('disabled', 'abnormal')
                AND NOT (
                  account_model.runtime_status = 'cooling_down'
                  AND (
                    coalesce(account_model.status_reason, '') GLOB '*_permanent'
                    OR (
                      account_model.status_cooldown_until IS NOT NULL
                      AND account_model.status_cooldown_until > ${nowValue}
                    )
                  )
                )
                AND NOT (
                  account_model.runtime_status = 'rate_limited'
                  AND (
                    account_model.status_reason = 'rate_limited_permanent'
                    OR (
                      account_model.status_cooldown_until IS NOT NULL
                      AND account_model.status_cooldown_until > ${nowValue}
                    )
                  )
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM managed_account_endpoint_models AS observation
              WHERE observation.account_id = account.id
                AND observation.endpoint_id = endpoint.id
                AND observation.managed_model_id = model.id
                AND (
                  observation.runtime_status IN ('disabled', 'abnormal')
                  OR (
                    observation.runtime_status IN ('cooling_down', 'rate_limited')
                    AND (
                      coalesce(observation.status_reason, '') GLOB '*_permanent'
                      OR (
                        observation.status_cooldown_until IS NOT NULL
                        AND observation.status_cooldown_until > ${nowValue}
                      )
                    )
                  )
                )
            )
        )
      `)
      .get();

    return Number(row?.count ?? 0);
  }

  public getProviderDetails(providerKey: string): ManagedProviderDetails | null {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();

    if (!provider) {
      return null;
    }

    const accounts = this.db.select().from(managedProviderCredentialsTable)
      .where(eq(managedProviderCredentialsTable.providerId, provider.id))
      .all()
      .sort((left, right) => {
        if (left.accountKey === "default" && right.accountKey !== "default") {
          return -1;
        }
        if (right.accountKey === "default" && left.accountKey !== "default") {
          return 1;
        }
        return left.accountKey.localeCompare(right.accountKey);
      });

    const credential = accounts[0] ?? null;

    const endpoints = this.db.select().from(managedProviderEndpointsTable)
      .where(eq(managedProviderEndpointsTable.providerId, provider.id))
      .all();

    const models = this.db.select().from(managedModelsTable)
      .where(eq(managedModelsTable.providerId, provider.id))
      .all();

    const accountModels = accounts.map((account) => {
      const accountModelRows = this.listAccountModelRows(account.id);
      const accountModelByModelId = new Map(
        accountModelRows.map((row) => [row.managedModelId, row] as const)
      );
      return {
        accountId: account.id,
        models: models
          .filter((model) => accountModelByModelId.has(model.id))
          .map((model) => {
            const status = accountModelByModelId.get(model.id)!;
            return {
              ...model,
              runtimeStatus: status.runtimeStatus,
              statusReason: status.statusReason,
              statusMessage: status.statusMessage,
              statusSource: status.statusSource,
              statusUpdatedAt: status.statusUpdatedAt,
              statusCooldownUntil: status.statusCooldownUntil,
              rateLimitStrike: status.rateLimitStrike,
              cooldownStrike: status.cooldownStrike,
              recentErrorCount: status.recentErrorCount,
              lastErrorAt: status.lastErrorAt,
              lastErrorCode: status.lastErrorCode,
              lastErrorMessage: status.lastErrorMessage
            };
          })
      };
    });

    const latestSync = this.db.select().from(modelSyncRunsTable)
      .where(eq(modelSyncRunsTable.providerId, provider.id))
      .orderBy(desc(modelSyncRunsTable.startedAt))
      .limit(1)
      .get() ?? null;

    const accountIds = new Set(accounts.map((account) => account.id));
    const endpointIds = new Set(endpoints.map((endpoint) => endpoint.id));
    const modelIds = new Set(models.map((model) => model.id));
    const accountEndpointModels = this.db.select().from(managedAccountEndpointModelsTable)
      .all()
      .filter((row) =>
        accountIds.has(row.accountId) &&
        endpointIds.has(row.endpointId) &&
        modelIds.has(row.managedModelId)
      );
    const accountEndpoints = this.db.select().from(managedAccountEndpointsTable)
      .all()
      .filter((row) => accountIds.has(row.accountId) && endpointIds.has(row.endpointId));

    return {
      provider,
      credential,
      accounts,
      accountModels,
      accountEndpointModels,
      accountEndpoints,
      endpoints,
      models,
      latestSync
    };
  }

  public getAccount(providerKey: string, accountKey: string): ManagedCredentialRow | null {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();
    if (!provider) {
      return null;
    }
    return this.db.select().from(managedProviderCredentialsTable)
      .where(and(
        eq(managedProviderCredentialsTable.providerId, provider.id),
        eq(managedProviderCredentialsTable.accountKey, accountKey)
      ))
      .get() ?? null;
  }

  public listAccounts(providerKey: string): ManagedCredentialRow[] {
    return this.getProviderDetails(providerKey)?.accounts ?? [];
  }

  public findProvidersByEndpointSet(
    inputs: ManagedEndpointSetInput[]
  ): ManagedProviderEndpointSetCandidate[] {
    const endpoints = this.db.select().from(managedProviderEndpointsTable).all();
    const endpointsByProvider = new Map<number, ManagedProviderEndpointRow[]>();
    for (const endpoint of endpoints) {
      const providerEndpoints = endpointsByProvider.get(endpoint.providerId) ?? [];
      providerEndpoints.push(endpoint);
      endpointsByProvider.set(endpoint.providerId, providerEndpoints);
    }

    const providers = new Map(
      this.db.select().from(managedProvidersTable).all().map((provider) => [provider.id, provider])
    );
    const results: ManagedProviderEndpointSetCandidate[] = [];

    for (const [providerId, providerEndpoints] of endpointsByProvider) {
      const provider = providers.get(providerId);
      if (!provider) {
        continue;
      }
      const candidate = classifyProviderEndpointSet(provider, providerEndpoints, inputs);
      if (candidate) {
        results.push(candidate);
      }
    }

    return results;
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
            endpointKey: input.provider.protocol ?? "openai-responses",
            protocol: input.provider.protocol ?? "openai-responses",
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

    const providerKind = defaultProviderKind(
      input.provider.providerKind ?? (existing.provider.providerKind as ProviderKind | undefined)
    );

    return this.db.transaction((tx) => {
      tx.update(managedProvidersTable)
        .set({
          displayName: input.provider.displayName,
          baseUrl: representativeEndpoint?.baseUrl ?? input.provider.baseUrl,
          websiteUrl: input.provider.websiteUrl ?? null,
          modelCatalogUrl: input.provider.modelCatalogUrl ?? null,
          providerKind,
          enabled: input.provider.enabled ?? existing.provider.enabled,
          priority:
            normalizeProviderPriority(input.provider.priority) ?? existing.provider.priority,
          trustLevel: input.provider.trustLevel ?? existing.provider.trustLevel,
          privacyLevel: input.provider.privacyLevel ?? existing.provider.privacyLevel,
          usageTrust: input.provider.usageTrust ?? existing.provider.usageTrust,
          updatedAt: now
        })
        .where(eq(managedProvidersTable.providerKey, input.providerKey))
        .run();

      tx.delete(managedModelsTable)
        .where(eq(managedModelsTable.providerId, existing.provider.id))
        .run();
      tx.delete(managedProviderEndpointsTable)
        .where(eq(managedProviderEndpointsTable.providerId, existing.provider.id))
        .run();

      const catalogModels = new Map<string, ManagedDiscoveredModelInput>();

      for (const bundle of input.endpointBundles) {
        tx.insert(managedProviderEndpointsTable)
          .values({
            providerId: existing.provider.id,
            endpointKey: bundle.endpoint.endpointKey,
            protocol: bundle.endpoint.protocol,
            baseUrl: bundle.endpoint.baseUrl,
            customHeadersJson: bundle.endpoint.customHeaders ? JSON.stringify(bundle.endpoint.customHeaders) : null,
            enabled: bundle.endpoint.enabled ?? true,
            supportsStreaming: bundle.endpoint.supportsStreaming ?? true,
            supportsTools: bundle.endpoint.supportsTools ?? bundle.models.some((model) => model.supportsTools),
            supportsJsonMode: bundle.endpoint.supportsJsonMode ?? bundle.models.some((model) => model.supportsJsonMode),
            createdAt: now,
            updatedAt: now
          })
          .run();

        for (const model of bundle.models) {
          catalogModels.set(model.providerModelId, model);
        }
      }

      if (catalogModels.size > 0) {
        const preservedByModelKey = this.preservedFieldsByModelKey(existing.models);
        this.insertManagedModels(
          tx as unknown as Db,
          Array.from(catalogModels.values()).map((model) =>
            this.buildManagedModelInsert({
              db: tx as unknown as Db,
              providerId: existing.provider.id,
              model,
              now,
              preserved: preservedByModelKey.get(model.modelKey)
            })
          )
        );
      }

      if (input.encryptedApiKey) {
        const currentCredential = tx.select().from(managedProviderCredentialsTable)
          .where(and(
            eq(managedProviderCredentialsTable.providerId, existing.provider.id),
            eq(managedProviderCredentialsTable.accountKey, "default")
          ))
          .get() ?? tx.select().from(managedProviderCredentialsTable)
          .where(eq(managedProviderCredentialsTable.providerId, existing.provider.id))
          .get();

        if (currentCredential) {
          tx.update(managedProviderCredentialsTable)
            .set({
              apiKeyEncrypted: input.encryptedApiKey,
              keyHint: input.apiKeyHint ?? null,
              updatedAt: now
            })
            .where(eq(managedProviderCredentialsTable.id, currentCredential.id))
            .run();
        } else {
          tx.insert(managedProviderCredentialsTable).values({
            providerId: existing.provider.id,
            accountKey: "default",
            enabled: true,
            runtimeStatus: "normal",
            statusSource: "system",
            recentErrorCount: 0,
            apiKeyEncrypted: input.encryptedApiKey,
            keyHint: input.apiKeyHint ?? null,
            createdAt: now,
            updatedAt: now
          }).run();
        }
      }

      tx.insert(modelSyncRunsTable).values({
        providerId: existing.provider.id,
        accountId: null,
        catalogUrl: input.provider.modelCatalogUrl ?? null,
        status: "success",
        errorMessage: null,
        startedAt: now,
        finishedAt: now,
        discoveredCount: catalogModels.size
      }).run();

      const modelIds = tx.select().from(managedModelsTable)
        .where(eq(managedModelsTable.providerId, existing.provider.id))
        .all()
        .map((model) => model.id);
      const accounts = tx.select().from(managedProviderCredentialsTable)
        .where(eq(managedProviderCredentialsTable.providerId, existing.provider.id))
        .all();
      for (const account of accounts) {
        this.replaceAccountModelLinks(
          tx as unknown as Db,
          account.id,
          modelIds,
          now
        );
      }

      return this.getProviderDetails(input.providerKey);
    });
  }

  public createProviderWithEndpointBundles(input: {
    provider: ManagedProviderInput;
    encryptedApiKey: string;
    apiKeyHint?: string;
    defaultAccount?: {
      accountKey: string;
      enabled?: boolean;
      expiresAt?: string | null;
      quotaJson?: string | null;
      remark?: string | null;
    };
    endpointBundles: ManagedEndpointBundleInput[];
    initialSync?: ManagedInitialModelSync;
  }): ManagedProviderDetails {
    const now = nowIso();

    const providerKind = defaultProviderKind(input.provider.providerKind);

    return this.db.transaction((tx) => {
      const providerInsert = tx.insert(managedProvidersTable)
        .values({
          providerKey: input.provider.providerKey,
          displayName: input.provider.displayName,
          baseUrl: input.provider.baseUrl,
          websiteUrl: input.provider.websiteUrl ?? null,
          modelCatalogUrl: input.provider.modelCatalogUrl ?? null,
          providerKind,
          enabled: input.provider.enabled ?? true,
          priority: normalizeProviderPriority(input.provider.priority) ?? 0,
          trustLevel: input.provider.trustLevel ?? "low",
          privacyLevel: input.provider.privacyLevel ?? "public_only",
          usageTrust: input.provider.usageTrust ?? "low",
          createdAt: now,
          updatedAt: now
        })
        .returning()
        .get();

      const catalogModels = new Map<string, ManagedDiscoveredModelInput>();
      for (const bundle of input.endpointBundles) {
        tx.insert(managedProviderEndpointsTable)
          .values({
            providerId: providerInsert.id,
            endpointKey: bundle.endpoint.endpointKey,
            protocol: bundle.endpoint.protocol,
            baseUrl: bundle.endpoint.baseUrl,
            customHeadersJson: bundle.endpoint.customHeaders ? JSON.stringify(bundle.endpoint.customHeaders) : null,
            enabled: bundle.endpoint.enabled ?? true,
            supportsStreaming: bundle.endpoint.supportsStreaming ?? true,
            supportsTools: bundle.endpoint.supportsTools ?? bundle.models.some((model) => model.supportsTools),
            supportsJsonMode: bundle.endpoint.supportsJsonMode ?? bundle.models.some((model) => model.supportsJsonMode),
            createdAt: now,
            updatedAt: now
          })
          .run();
        for (const model of bundle.models) {
          catalogModels.set(model.providerModelId, model);
        }
      }

      if (catalogModels.size > 0) {
        this.insertManagedModels(
          tx as unknown as Db,
          Array.from(catalogModels.values()).map((model) =>
            this.buildManagedModelInsert({
              db: tx as unknown as Db,
              providerId: providerInsert.id,
              model,
              now
            })
          )
        );
      }

      const defaultAccount = tx.insert(managedProviderCredentialsTable).values({
        providerId: providerInsert.id,
        accountKey: input.defaultAccount?.accountKey ?? "default",
        enabled: input.defaultAccount?.enabled ?? true,
        runtimeStatus: "normal",
        statusSource: "system",
        recentErrorCount: 0,
        expiresAt: input.defaultAccount?.expiresAt ?? null,
        quotaJson: input.defaultAccount?.quotaJson ?? null,
        remark: input.defaultAccount?.remark ?? null,
        apiKeyEncrypted: input.encryptedApiKey,
        keyHint: input.apiKeyHint ?? null,
        createdAt: now,
        updatedAt: now
      }).returning().get();

      const modelIds = tx.select().from(managedModelsTable)
        .where(eq(managedModelsTable.providerId, providerInsert.id))
        .all()
        .map((model) => model.id);
      this.replaceAccountModelLinks(
        tx as unknown as Db,
        defaultAccount.id,
        modelIds,
        now
      );

      tx.insert(modelSyncRunsTable).values({
        providerId: providerInsert.id,
        accountId: defaultAccount.id,
        catalogUrl: input.initialSync?.catalogUrl ?? input.provider.modelCatalogUrl ?? null,
        status: input.initialSync?.status ?? "success",
        errorMessage: input.initialSync?.errorMessage ?? null,
        startedAt: now,
        finishedAt: now,
        discoveredCount: input.initialSync?.discoveredCount ?? catalogModels.size
      }).run();

      return this.getProviderDetails(providerInsert.providerKey)!;
    });
  }

  public syncProviderModels(providerKey: string, input: {
    accountKey?: string;
    catalogUrl?: string | null;
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

    const accountKey = input.accountKey ?? "default";
    const account = this.getAccount(providerKey, accountKey);
    if (!account) {
      return null;
    }
    const now = nowIso();

    this.db.transaction((tx) => {
      tx.insert(modelSyncRunsTable).values({
        providerId: provider.id,
        accountId: account.id,
        catalogUrl: input.catalogUrl ?? null,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
        startedAt: now,
        finishedAt: now,
        discoveredCount: input.models.length
      }).run();

      if (input.status !== "success") {
        return;
      }

      const existingProviderModels = tx.select().from(managedModelsTable)
        .where(eq(managedModelsTable.providerId, provider.id))
        .all();
      const preservedByModelKey = this.preservedFieldsByModelKey(existingProviderModels);
      const manualModelIds = existingProviderModels
        .filter(isManualModel)
        .map((model) => model.id);

      const touchedIds: number[] = [];
      for (const model of input.models) {
        const existing = existingProviderModels.find(
          (item) => item.modelKey === model.modelKey || item.providerModelId === model.providerModelId
        );
        if (existing) {
          tx.update(managedModelsTable)
            .set({
              modelKey: model.modelKey,
              providerModelId: model.providerModelId,
              modelName: model.modelName,
              contextWindow: model.contextWindow,
              supportsStreaming: model.supportsStreaming,
              supportsTools: model.supportsTools,
              supportsJsonMode: model.supportsJsonMode,
              pricingJson: model.pricingJson ?? null,
              rawMetadataJson: model.rawMetadataJson ?? null,
              updatedAt: now
            })
            .where(eq(managedModelsTable.id, existing.id))
            .run();
          touchedIds.push(existing.id);
        } else {
          const inserted = tx.insert(managedModelsTable).values(
            this.buildManagedModelInsert({
              db: tx as unknown as Db,
              providerId: provider.id,
              model,
              now,
              preserved: preservedByModelKey.get(model.modelKey)
            })
          ).returning().get();
          touchedIds.push(inserted.id);
        }
      }

      this.replaceAccountModelLinks(
        tx as unknown as Db,
        account.id,
        Array.from(new Set([...touchedIds, ...manualModelIds])),
        now
      );
    });

    return this.getProviderDetails(providerKey);
  }

  public listEnabledProviderBundles(): Array<{
    provider: ManagedProviderRow;
    credential: ManagedCredentialRow;
    endpoint: ManagedProviderEndpointRow;
    accountEndpoint: ManagedAccountEndpointRow | null;
    models: ManagedModelRow[];
  }> {
    const providers = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.enabled, true))
      .all();

    return providers.flatMap((provider) => {
      const accounts = this.db.select().from(managedProviderCredentialsTable)
        .where(and(
          eq(managedProviderCredentialsTable.providerId, provider.id),
          eq(managedProviderCredentialsTable.enabled, true)
        ))
        .all();

      if (accounts.length === 0) {
        return [];
      }

      const endpoints = this.db.select().from(managedProviderEndpointsTable)
        .where(and(
          eq(managedProviderEndpointsTable.providerId, provider.id),
          eq(managedProviderEndpointsTable.enabled, true)
        ))
        .all();
      const providerModels = this.db.select().from(managedModelsTable)
        .where(and(
          eq(managedModelsTable.providerId, provider.id),
          eq(managedModelsTable.enabled, true)
        ))
        .all();
      return accounts.flatMap((account) => {
        const accountModelIds = this.listAccountModelIds(account.id);

        return endpoints.flatMap((endpoint) => {
          const accountEndpoint = this.getAccountEndpoint(provider.providerKey, account.accountKey, endpoint.endpointKey);
          if (accountEndpoint && (!accountEndpoint.enabled || accountUnavailableReason({
            runtimeStatus: isRuntimeStatusValue(accountEndpoint.runtimeStatus) ? accountEndpoint.runtimeStatus : "unknown",
            statusReason: accountEndpoint.statusReason,
            statusCooldownUntil: accountEndpoint.statusCooldownUntil
          }))) {
            return [];
          }
          const observations = this.db.select().from(managedAccountEndpointModelsTable)
            .where(and(
              eq(managedAccountEndpointModelsTable.accountId, account.id),
              eq(managedAccountEndpointModelsTable.endpointId, endpoint.id)
            ))
            .all();
          const observationByModelId = new Map(
            observations.map((observation) => [observation.managedModelId, observation])
          );
          const now = Date.now();
          const models = providerModels.filter((model) => {
            if (!accountModelIds.has(model.id)) {
              return false;
            }
            const observation = observationByModelId.get(model.id);
            if (!observation) {
              return true;
            }
            if (observation.runtimeStatus === "disabled" || observation.runtimeStatus === "abnormal") {
              return false;
            }
            if (
              observation.runtimeStatus !== "cooling_down" &&
              observation.runtimeStatus !== "rate_limited"
            ) {
              return true;
            }
            if (observation.statusReason?.endsWith("_permanent")) {
              return false;
            }
            const cooldownUntil = observation.statusCooldownUntil
              ? Date.parse(observation.statusCooldownUntil)
              : Number.NaN;
            return !Number.isFinite(cooldownUntil) || cooldownUntil <= now;
          });

          return {
            provider,
            credential: account,
            endpoint,
            accountEndpoint,
            models
          };
        });
      });
    });
  }

  public listLogicalModelsByIds(ids: number[]): Map<number, import("../db/schema.js").LogicalModelRow> {
    if (ids.length === 0) {
      return new Map();
    }

    const idSet = new Set(ids);
    const rows = this.db.select().from(logicalModelsTable).all()
      .filter((row) => idSet.has(row.id));
    return new Map(rows.map((row) => [row.id, row]));
  }

  public updateProviderEnabled(providerKey: string, enabled: boolean): ManagedProviderDetails | null {
    const existing = this.getProviderDetails(providerKey);
    if (!existing) {
      return null;
    }
    const now = nowIso();
    if (enabled) {
      this.db.update(managedProvidersTable)
        .set({
          enabled: true,
          updatedAt: now
        })
        .where(eq(managedProvidersTable.id, existing.provider.id))
        .run();
      return this.getProviderDetails(providerKey);
    }
    this.db.update(managedProvidersTable)
      .set({
        enabled: false,
        updatedAt: now
      })
      .where(eq(managedProvidersTable.id, existing.provider.id))
      .run();
    return this.getProviderDetails(providerKey);
  }

  public getMaxProviderPriority(): number {
    const providers = this.db.select().from(managedProvidersTable).all();
    return providers.reduce((max, provider) => Math.max(max, provider.priority ?? 0), 0);
  }

  public elevateProviderPriority(providerKey: string): ManagedProviderDetails | null {
    const existing = this.getProviderDetails(providerKey);
    if (!existing) {
      return null;
    }
    const now = nowIso();
    const nextPriority = this.getMaxProviderPriority() + 1;
    this.db.update(managedProvidersTable)
      .set({
        priority: nextPriority,
        updatedAt: now
      })
      .where(eq(managedProvidersTable.id, existing.provider.id))
      .run();
    return this.getProviderDetails(providerKey);
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
        websiteUrl:
          input.websiteUrl !== undefined ? input.websiteUrl : existing.provider.websiteUrl,
        modelCatalogUrl:
          input.modelCatalogUrl !== undefined
            ? input.modelCatalogUrl
            : existing.provider.modelCatalogUrl,
        providerKind: input.providerKind ?? existing.provider.providerKind,
        enabled: input.enabled ?? existing.provider.enabled,
        priority: normalizeProviderPriority(input.priority) ?? existing.provider.priority,
        updatedAt: now
      })
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .run();

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

  public getProviderEndpointByProtocol(
    providerKey: string,
    protocol: WireProtocol
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
        eq(managedProviderEndpointsTable.protocol, protocol)
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
        baseUrl: input.baseUrl,
        customHeadersJson: input.customHeaders ? JSON.stringify(input.customHeaders) : null,
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

  public replaceProviderEndpoints(
    providerKey: string,
    endpoints: ManagedEndpointInput[]
  ): ManagedProviderDetails | null {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();
    if (!provider) {
      return null;
    }
    const now = nowIso();
    this.db.transaction((tx) => {
      tx.delete(managedProviderEndpointsTable)
        .where(eq(managedProviderEndpointsTable.providerId, provider.id))
        .run();
      for (const endpoint of endpoints) {
        tx.insert(managedProviderEndpointsTable).values({
          providerId: provider.id,
          endpointKey: endpoint.protocol,
          protocol: endpoint.protocol,
          baseUrl: endpoint.baseUrl,
          customHeadersJson: endpoint.customHeaders ? JSON.stringify(endpoint.customHeaders) : null,
          enabled: endpoint.enabled ?? true,
          supportsStreaming: endpoint.supportsStreaming ?? true,
          supportsTools: endpoint.supportsTools ?? false,
          supportsJsonMode: endpoint.supportsJsonMode ?? false,
          createdAt: now,
          updatedAt: now
        }).run();
      }
      tx.update(managedProvidersTable)
        .set({
          baseUrl: endpoints[0]?.baseUrl ?? provider.baseUrl,
          updatedAt: now
        })
        .where(eq(managedProvidersTable.id, provider.id))
        .run();
    });
    return this.getProviderDetails(providerKey);
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

    if (input.protocol && input.protocol !== endpoint.protocol) {
      const now = nowIso();
      this.db.transaction((tx) => {
        tx.delete(managedProviderEndpointsTable)
          .where(eq(managedProviderEndpointsTable.id, endpoint.id))
          .run();
        tx.insert(managedProviderEndpointsTable).values({
          providerId: endpoint.providerId,
          endpointKey: input.protocol!,
          protocol: input.protocol!,
          baseUrl: input.baseUrl ?? endpoint.baseUrl,
          customHeadersJson:
            input.customHeaders !== undefined
              ? input.customHeaders
                ? JSON.stringify(input.customHeaders)
                : null
              : endpoint.customHeadersJson,
          enabled: input.enabled ?? endpoint.enabled,
          supportsStreaming: input.supportsStreaming ?? endpoint.supportsStreaming,
          supportsTools: input.supportsTools ?? endpoint.supportsTools,
          supportsJsonMode: input.supportsJsonMode ?? endpoint.supportsJsonMode,
          createdAt: now,
          updatedAt: now
        }).run();
      });
      const provider = this.db.select().from(managedProvidersTable)
        .where(eq(managedProvidersTable.id, endpoint.providerId))
        .get();
      return provider ? this.getProviderDetails(provider.providerKey) : null;
    }

    const now = nowIso();
    const recoverRuntimeStatus = input.enabled === true
      ? {
          runtimeStatus: "normal" as const,
          statusReason: null,
          statusMessage: null,
          statusSource: "manual",
          statusUpdatedAt: now,
          statusCooldownUntil: null,
          cooldownStrike: 0,
          recentErrorCount: 0
        }
      : {};
    this.db.update(managedProviderEndpointsTable)
      .set({
        ...recoverRuntimeStatus,
        protocol: input.protocol ?? endpoint.protocol,
        baseUrl: input.baseUrl ?? endpoint.baseUrl,
        customHeadersJson: input.customHeaders !== undefined ? (input.customHeaders ? JSON.stringify(input.customHeaders) : null) : endpoint.customHeadersJson,
        enabled: input.enabled ?? endpoint.enabled,
        supportsStreaming: input.supportsStreaming ?? endpoint.supportsStreaming,
        supportsTools: input.supportsTools ?? endpoint.supportsTools,
        supportsJsonMode: input.supportsJsonMode ?? endpoint.supportsJsonMode,
        updatedAt: now
      })
      .where(eq(managedProviderEndpointsTable.id, endpoint.id))
      .run();

    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.id, endpoint.providerId))
      .get();

    return provider ? this.getProviderDetails(provider.providerKey) : null;
  }

  public applyEndpointCooldown(
    providerKey: string,
    endpointKey: string,
    input: {
      strike: number;
      permanent: boolean;
      cooldownUntil: string | null;
      code?: string;
      message: string;
    }
  ): ManagedProviderEndpointRow | null {
    const endpoint = this.getProviderEndpoint(providerKey, endpointKey);
    if (!endpoint) {
      return null;
    }
    const now = nowIso();
    this.db.update(managedProviderEndpointsTable)
      .set({
        runtimeStatus: input.permanent ? "abnormal" : "cooling_down",
        statusReason: input.permanent ? "connection_error_permanent" : "connection_error_cooldown",
        statusMessage: input.message,
        statusSource: "system",
        statusUpdatedAt: now,
        statusCooldownUntil: input.permanent ? null : input.cooldownUntil,
        cooldownStrike: input.strike,
        recentErrorCount: endpoint.recentErrorCount + 1,
        lastErrorAt: now,
        lastErrorCode: input.code ?? "provider_unreachable",
        lastErrorMessage: input.message,
        updatedAt: now
      })
      .where(eq(managedProviderEndpointsTable.id, endpoint.id))
      .run();
    return this.getProviderEndpoint(providerKey, endpointKey);
  }

  public markEndpointSuccess(
    providerKey: string,
    endpointKey: string,
    clearCounters: boolean
  ): ManagedProviderEndpointRow | null {
    const endpoint = this.getProviderEndpoint(providerKey, endpointKey);
    if (!endpoint) {
      return null;
    }
    if (endpoint.runtimeStatus === "abnormal" || endpoint.runtimeStatus === "disabled") {
      return endpoint;
    }
    const now = nowIso();
    this.db.update(managedProviderEndpointsTable)
      .set({
        runtimeStatus: "normal",
        statusReason: null,
        statusMessage: null,
        statusSource: "system",
        statusUpdatedAt: now,
        statusCooldownUntil: null,
        cooldownStrike: clearCounters ? 0 : endpoint.cooldownStrike,
        recentErrorCount: clearCounters ? 0 : endpoint.recentErrorCount,
        updatedAt: now
      })
      .where(eq(managedProviderEndpointsTable.id, endpoint.id))
      .run();
    return this.getProviderEndpoint(providerKey, endpointKey);
  }

  public upsertManualModel(providerKey: string, input: {
    accountKey?: string;
    model: ManagedDiscoveredModelInput;
  }): ManagedProviderDetails | null {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();
    if (!provider) {
      return null;
    }

    const accounts = input.accountKey
      ? [this.getAccount(providerKey, input.accountKey)].filter(
          (account): account is ManagedCredentialRow => account !== null
        )
      : this.listAccounts(providerKey);
    const now = nowIso();

    this.db.transaction((tx) => {
      const existing = tx.select().from(managedModelsTable)
        .where(and(
          eq(managedModelsTable.providerId, provider.id),
          eq(managedModelsTable.modelKey, input.model.modelKey)
        ))
        .get() ?? tx.select().from(managedModelsTable)
        .where(and(
          eq(managedModelsTable.providerId, provider.id),
          eq(managedModelsTable.providerModelId, input.model.providerModelId)
        ))
        .get();

      let modelId: number;
      if (existing) {
        tx.update(managedModelsTable)
          .set({
            modelKey: input.model.modelKey,
            providerModelId: input.model.providerModelId,
            modelName: input.model.modelName,
            contextWindow: input.model.contextWindow,
            supportsStreaming: input.model.supportsStreaming,
            supportsTools: input.model.supportsTools,
            supportsJsonMode: input.model.supportsJsonMode,
            pricingJson: input.model.pricingJson ?? null,
            rawMetadataJson: input.model.rawMetadataJson ?? null,
            updatedAt: now
          })
          .where(eq(managedModelsTable.id, existing.id))
          .run();
        modelId = existing.id;
      } else {
        const inserted = tx.insert(managedModelsTable).values(
          this.buildManagedModelInsert({
            db: tx as unknown as Db,
            providerId: provider.id,
            model: input.model,
            now
          })
        ).returning().get();
        modelId = inserted.id;
      }

      for (const account of accounts) {
        this.upsertAccountModelLinks(tx as unknown as Db, account.id, [modelId], now);
      }
    });

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
    const enableRecover =
      input.enabled === true
        ? {
            enabled: true,
            runtimeStatus: "normal" as const,
            statusReason: null,
            statusMessage: null,
            statusSource: "manual",
            statusUpdatedAt: now,
            statusCooldownUntil: null,
            rateLimitStrike: 0,
            recentErrorCount: 0
          }
        : input.enabled === false
          ? { enabled: false }
          : {};
    this.db.update(managedModelsTable)
      .set({
        ...enableRecover,
        supportsStreaming: input.supportsStreaming ?? model.supportsStreaming,
        supportsTools: input.supportsTools ?? model.supportsTools,
        supportsJsonMode: input.supportsJsonMode ?? model.supportsJsonMode,
        supportsStreamingOverride: input.supportsStreaming ?? model.supportsStreamingOverride,
        supportsToolsOverride: input.supportsTools ?? model.supportsToolsOverride,
        supportsJsonModeOverride: input.supportsJsonMode ?? model.supportsJsonModeOverride,
        manualOverrideJson: JSON.stringify({
          ...(model.manualOverrideJson ? JSON.parse(model.manualOverrideJson) as Record<string, unknown> : {}),
          ...(input.enabled !== undefined ? { enabled: true } : {}),
          ...(input.supportsStreaming !== undefined ? { supports_streaming: true } : {}),
          ...(input.supportsTools !== undefined ? { supports_tools: true } : {}),
          ...(input.supportsJsonMode !== undefined ? { supports_json_mode: true } : {})
        }),
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
      .where(and(
        eq(managedProviderCredentialsTable.providerId, provider.id),
        eq(managedProviderCredentialsTable.accountKey, "default")
      ))
      .get() ?? this.db.select().from(managedProviderCredentialsTable)
      .where(eq(managedProviderCredentialsTable.providerId, provider.id))
      .get();

    if (existing) {
      this.db.update(managedProviderCredentialsTable)
        .set({
          apiKeyEncrypted: encryptedApiKey,
          keyHint: apiKeyHint,
          updatedAt: now
        })
        .where(eq(managedProviderCredentialsTable.id, existing.id))
        .run();
      return true;
    }

    this.db.insert(managedProviderCredentialsTable).values({
      providerId: provider.id,
      accountKey: "default",
      enabled: true,
      runtimeStatus: "normal",
      statusSource: "system",
      recentErrorCount: 0,
      apiKeyEncrypted: encryptedApiKey,
      keyHint: apiKeyHint,
      createdAt: now,
      updatedAt: now
    }).run();

    return true;
  }

  public createAccount(
    providerKey: string,
    input: ManagedAccountInput
  ): ManagedCredentialRow | null {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();
    if (!provider) {
      return null;
    }

    const existing = this.getAccount(providerKey, input.accountKey);
    if (existing) {
      return null;
    }

    const now = nowIso();
    return this.db.transaction((tx) => {
      const created = tx.insert(managedProviderCredentialsTable).values({
        providerId: provider.id,
        accountKey: input.accountKey,
        enabled: input.enabled ?? true,
        runtimeStatus: "normal",
        statusSource: "system",
        recentErrorCount: 0,
        expiresAt: input.expiresAt ?? null,
        quotaJson: input.quotaJson ?? null,
        remark: input.remark ?? null,
        apiKeyEncrypted: input.encryptedApiKey,
        keyHint: input.apiKeyHint ?? null,
        createdAt: now,
        updatedAt: now
      }).returning().get();
      const manualModelIds = tx.select().from(managedModelsTable)
        .where(eq(managedModelsTable.providerId, provider.id))
        .all()
        .filter(isManualModel)
        .map((model) => model.id);
      this.upsertAccountModelLinks(tx as unknown as Db, created.id, manualModelIds, now);
      return created;
    });
  }

  public updateAccount(
    providerKey: string,
    accountKey: string,
    input: ManagedAccountUpdateInput
  ): ManagedCredentialRow | null {
    const account = this.getAccount(providerKey, accountKey);
    if (!account) {
      return null;
    }

    const now = nowIso();
    const enableRecover =
      input.enabled === true
        ? {
            enabled: true,
            runtimeStatus: "normal" as const,
            statusReason: null,
            statusMessage: null,
            statusSource: "manual",
            statusUpdatedAt: now,
            statusCooldownUntil: null,
            cooldownStrike: 0,
            recentErrorCount: 0
          }
        : input.enabled === false
          ? { enabled: false }
          : {};

    this.db.update(managedProviderCredentialsTable)
      .set({
        ...enableRecover,
        expiresAt: input.expiresAt !== undefined ? input.expiresAt : account.expiresAt,
        quotaJson: input.quotaJson !== undefined ? input.quotaJson : account.quotaJson,
        remark: input.remark !== undefined ? input.remark : account.remark,
        apiKeyEncrypted: input.encryptedApiKey ?? account.apiKeyEncrypted,
        keyHint: input.apiKeyHint !== undefined ? input.apiKeyHint : account.keyHint,
        updatedAt: now
      })
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .run();

    return this.db.select().from(managedProviderCredentialsTable)
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .get() ?? null;
  }

  public deleteAccount(providerKey: string, accountKey: string): boolean {
    const account = this.getAccount(providerKey, accountKey);
    if (!account) {
      return false;
    }

    // Keep at least one account so provider remains usable.
    const siblings = this.listAccounts(providerKey);
    if (siblings.length <= 1) {
      return false;
    }

    const result = this.db.delete(managedProviderCredentialsTable)
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .run();
    return result.changes > 0;
  }

  public setAccountEnabled(
    providerKey: string,
    accountKey: string,
    enabled: boolean
  ): ManagedCredentialRow | null {
    return this.updateAccount(providerKey, accountKey, { enabled });
  }

  /** 把 account 打成需人工恢复的 disabled（鉴权失败 / 账单失败） */
  public markAccountDisabled(
    providerKey: string,
    accountKey: string,
    input: {
      reason: string;
      code: string;
      message: string;
      fallbackMessage: string;
    }
  ): ManagedCredentialRow | null {
    const account = this.getAccount(providerKey, accountKey);
    if (!account) {
      return null;
    }
    const now = nowIso();
    const message = input.message || input.fallbackMessage;
    this.db.update(managedProviderCredentialsTable)
      .set({
        runtimeStatus: "disabled",
        statusReason: input.reason,
        statusMessage: message,
        statusSource: "system",
        statusUpdatedAt: now,
        statusCooldownUntil: null,
        lastErrorAt: now,
        lastErrorCode: input.code,
        lastErrorMessage: message,
        updatedAt: now
      })
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .run();
    return this.db.select().from(managedProviderCredentialsTable)
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .get() ?? null;
  }

  public markAccountAuthFailed(
    providerKey: string,
    accountKey: string,
    message: string
  ): ManagedCredentialRow | null {
    return this.markAccountDisabled(providerKey, accountKey, {
      reason: "auth_failed",
      code: "provider_auth_failed",
      message,
      fallbackMessage: "Invalid API key"
    });
  }

  public markAccountBillingFailed(
    providerKey: string,
    accountKey: string,
    message: string
  ): ManagedCredentialRow | null {
    return this.markAccountDisabled(providerKey, accountKey, {
      reason: "billing_failed",
      code: "provider_billing_failed",
      message,
      fallbackMessage: "Account balance or quota exhausted"
    });
  }

  /**
   * 上游 5xx / 超时 / 不可达：把整个 account 打进 cooling_down。
   * 冷却期内该 account 下所有 model 的候选都会被跳过，一次报错即生效。
   */
  public applyAccountCooldown(
    providerKey: string,
    accountKey: string,
    input: {
      strike: number;
      permanent: boolean;
      cooldownUntil: string | null;
      code?: string;
      message: string;
    }
  ): ManagedCredentialRow | null {
    const account = this.getAccount(providerKey, accountKey);
    if (!account) {
      return null;
    }
    const now = nowIso();
    this.db.update(managedProviderCredentialsTable)
      .set({
        runtimeStatus: input.permanent ? "abnormal" : "cooling_down",
        statusReason: input.permanent ? "error_permanent" : "error_cooldown",
        statusMessage: input.message,
        statusSource: "system",
        statusUpdatedAt: now,
        statusCooldownUntil: input.permanent ? null : input.cooldownUntil,
        cooldownStrike: input.strike,
        recentErrorCount: account.recentErrorCount + 1,
        lastErrorAt: now,
        lastErrorCode: input.code ?? "provider_error",
        lastErrorMessage: input.message,
        updatedAt: now
      })
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .run();
    return this.db.select().from(managedProviderCredentialsTable)
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .get() ?? null;
  }

  /** 请求本身被上游拒绝（400/413/422）：只留痕，不改运行态、不影响调度 */
  public recordAccountClientError(
    providerKey: string,
    accountKey: string,
    input: { code?: string; message: string }
  ): ManagedCredentialRow | null {
    const account = this.getAccount(providerKey, accountKey);
    if (!account) {
      return null;
    }
    const now = nowIso();
    this.db.update(managedProviderCredentialsTable)
      .set({
        lastErrorAt: now,
        lastErrorCode: input.code ?? "request_invalid",
        lastErrorMessage: input.message,
        updatedAt: now
      })
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .run();
    return this.db.select().from(managedProviderCredentialsTable)
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .get() ?? null;
  }

  public applyAccountRateLimit(
    providerKey: string,
    accountKey: string,
    input: {
      permanent: boolean;
      cooldownUntil: string | null;
      message: string;
      recentErrorCount?: number;
    }
  ): ManagedCredentialRow | null {
    const account = this.getAccount(providerKey, accountKey);
    if (!account) {
      return null;
    }
    const now = nowIso();
    this.db.update(managedProviderCredentialsTable)
      .set({
        runtimeStatus: "rate_limited",
        statusReason: input.permanent ? "rate_limited_permanent" : "rate_limited",
        statusMessage: input.message,
        statusSource: "system",
        statusUpdatedAt: now,
        statusCooldownUntil: input.permanent ? null : input.cooldownUntil,
        recentErrorCount: input.recentErrorCount ?? account.recentErrorCount,
        lastErrorAt: now,
        lastErrorCode: "provider_rate_limited",
        lastErrorMessage: input.message,
        updatedAt: now
      })
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .run();
    return this.db.select().from(managedProviderCredentialsTable)
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .get() ?? null;
  }

  public markAccountSuccess(
    providerKey: string,
    accountKey: string,
    clearCounters: boolean
  ): ManagedCredentialRow | null {
    const account = this.getAccount(providerKey, accountKey);
    if (!account) {
      return null;
    }
    // 永久态需人工 enable；cooling_down 属于可自愈状态，成功即清除。
    if (
      account.runtimeStatus === "abnormal" ||
      account.runtimeStatus === "disabled" ||
      account.statusReason === "rate_limited_permanent"
    ) {
      return account;
    }
    const now = nowIso();
    this.db.update(managedProviderCredentialsTable)
      .set({
        runtimeStatus: "normal",
        statusReason: null,
        statusMessage: null,
        statusSource: "system",
        statusUpdatedAt: now,
        statusCooldownUntil: null,
        cooldownStrike: clearCounters ? 0 : account.cooldownStrike,
        recentErrorCount: clearCounters ? 0 : account.recentErrorCount,
        updatedAt: now
      })
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .run();
    return this.db.select().from(managedProviderCredentialsTable)
      .where(eq(managedProviderCredentialsTable.id, account.id))
      .get() ?? null;
  }

  public getModelByProviderAndKey(providerKey: string, modelKey: string): ManagedModelRow | null {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();
    if (!provider) {
      return null;
    }
    return this.db.select().from(managedModelsTable)
      .where(and(
        eq(managedModelsTable.providerId, provider.id),
        eq(managedModelsTable.modelKey, modelKey)
      ))
      .get() ?? null;
  }

  public getAccountModel(
    providerKey: string,
    accountKey: string,
    modelKey: string
  ): ManagedAccountModelRow | null {
    const provider = this.db.select().from(managedProvidersTable)
      .where(eq(managedProvidersTable.providerKey, providerKey))
      .get();
    if (!provider) {
      return null;
    }
    const account = this.db.select().from(managedProviderCredentialsTable)
      .where(and(
        eq(managedProviderCredentialsTable.providerId, provider.id),
        eq(managedProviderCredentialsTable.accountKey, accountKey)
      ))
      .get();
    const model = this.db.select().from(managedModelsTable)
      .where(and(
        eq(managedModelsTable.providerId, provider.id),
        eq(managedModelsTable.modelKey, modelKey)
      ))
      .get();
    if (!account || !model) {
      return null;
    }
    return this.db.select().from(managedAccountModelsTable)
      .where(and(
        eq(managedAccountModelsTable.accountId, account.id),
        eq(managedAccountModelsTable.managedModelId, model.id)
      ))
      .get() ?? null;
  }

  public getAccountEndpoint(providerKey: string, accountKey: string, endpointKey: string): ManagedAccountEndpointRow | null {
    const account = this.getAccount(providerKey, accountKey);
    const endpoint = this.getProviderEndpoint(providerKey, endpointKey);
    if (!account || !endpoint) {
      return null;
    }
    return this.db.select().from(managedAccountEndpointsTable).where(and(
      eq(managedAccountEndpointsTable.accountId, account.id),
      eq(managedAccountEndpointsTable.endpointId, endpoint.id)
    )).get() ?? null;
  }

  private updateAccountEndpoint(
    providerKey: string, accountKey: string, endpointKey: string,
    values: Partial<Omit<ManagedAccountEndpointRow, "id" | "accountId" | "endpointId" | "createdAt">>
  ): ManagedAccountEndpointRow | null {
    const account = this.getAccount(providerKey, accountKey);
    const endpoint = this.getProviderEndpoint(providerKey, endpointKey);
    if (!account || !endpoint) {
      return null;
    }
    const now = nowIso();
    this.db.insert(managedAccountEndpointsTable).values({
      accountId: account.id, endpointId: endpoint.id, ...values, createdAt: now, updatedAt: now
    }).onConflictDoUpdate({
      target: [managedAccountEndpointsTable.accountId, managedAccountEndpointsTable.endpointId],
      set: { ...values, updatedAt: now }
    }).run();
    return this.getAccountEndpoint(providerKey, accountKey, endpointKey);
  }

  public setAccountEndpointEnabled(providerKey: string, accountKey: string, endpointKey: string, enabled: boolean) {
    return this.updateAccountEndpoint(providerKey, accountKey, endpointKey, { enabled });
  }

  public clearAccountEndpointStatus(providerKey: string, accountKey: string, endpointKey: string) {
    return this.updateAccountEndpoint(providerKey, accountKey, endpointKey, {
      runtimeStatus: "unknown", statusReason: null, statusMessage: null,
      statusSource: "manual", statusUpdatedAt: nowIso(), statusCooldownUntil: null,
      cooldownStrike: 0, rateLimitStrike: 0, recentErrorCount: 0,
      lastSuccessAt: null, lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null
    });
  }

  public applyAccountEndpointFailure(
    providerKey: string, accountKey: string, endpointKey: string,
    input: { runtimeStatus: "disabled" | "rate_limited" | "cooling_down" | "abnormal";
      reason: string; cooldownUntil: string | null; cooldownStrike?: number;
      rateLimitStrike?: number; code?: string; message: string }
  ) {
    const previous = this.getAccountEndpoint(providerKey, accountKey, endpointKey);
    return this.updateAccountEndpoint(providerKey, accountKey, endpointKey, {
      runtimeStatus: input.runtimeStatus, statusReason: input.reason, statusMessage: input.message,
      statusSource: "system", statusUpdatedAt: nowIso(), statusCooldownUntil: input.cooldownUntil,
      cooldownStrike: input.cooldownStrike ?? previous?.cooldownStrike ?? 0,
      rateLimitStrike: input.rateLimitStrike ?? previous?.rateLimitStrike ?? 0,
      recentErrorCount: (previous?.recentErrorCount ?? 0) + 1,
      lastErrorAt: nowIso(), lastErrorCode: input.code ?? "provider_error", lastErrorMessage: input.message
    });
  }

  public markAccountEndpointSuccess(providerKey: string, accountKey: string, endpointKey: string, clearCounters: boolean) {
    return this.updateAccountEndpoint(providerKey, accountKey, endpointKey, {
      runtimeStatus: "normal", statusReason: null, statusMessage: null,
      statusSource: "system", statusUpdatedAt: nowIso(), statusCooldownUntil: null,
      lastSuccessAt: nowIso(),
      ...(clearCounters ? { cooldownStrike: 0, rateLimitStrike: 0, recentErrorCount: 0 } : {})
    });
  }

  private getAccountEndpointModelTarget(
    providerKey: string,
    accountKey: string,
    endpointKey: string,
    modelKey: string
  ): {
    account: ManagedCredentialRow;
    endpoint: ManagedProviderEndpointRow;
    model: ManagedModelRow;
    observation: ManagedAccountEndpointModelRow | null;
  } | null {
    const account = this.getAccount(providerKey, accountKey);
    const endpoint = this.getProviderEndpoint(providerKey, endpointKey);
    const model = this.getModelByProviderAndKey(providerKey, modelKey);
    if (!account || !endpoint || !model) {
      return null;
    }
    const accountModel = this.db.select().from(managedAccountModelsTable)
      .where(and(
        eq(managedAccountModelsTable.accountId, account.id),
        eq(managedAccountModelsTable.managedModelId, model.id),
        eq(managedAccountModelsTable.enabled, true)
      ))
      .get();
    if (!accountModel) {
      return null;
    }
    const observation = this.db.select().from(managedAccountEndpointModelsTable)
      .where(and(
        eq(managedAccountEndpointModelsTable.accountId, account.id),
        eq(managedAccountEndpointModelsTable.endpointId, endpoint.id),
        eq(managedAccountEndpointModelsTable.managedModelId, model.id)
      ))
      .get() ?? null;
    return { account, endpoint, model, observation };
  }

  public getAccountEndpointModel(
    providerKey: string,
    accountKey: string,
    endpointKey: string,
    modelKey: string
  ): ManagedAccountEndpointModelRow | null {
    return this.getAccountEndpointModelTarget(
      providerKey,
      accountKey,
      endpointKey,
      modelKey
    )?.observation ?? null;
  }

  public applyAccountEndpointModelFailure(
    providerKey: string,
    accountKey: string,
    endpointKey: string,
    modelKey: string,
    input: {
      runtimeStatus: "rate_limited" | "cooling_down" | "abnormal";
      reason: string;
      cooldownUntil: string | null;
      rateLimitStrike?: number;
      cooldownStrike?: number;
      code?: string;
      message: string;
    }
  ): ManagedAccountEndpointModelRow | null {
    const target = this.getAccountEndpointModelTarget(
      providerKey,
      accountKey,
      endpointKey,
      modelKey
    );
    if (!target) {
      return null;
    }
    const now = nowIso();
    const values = {
      runtimeStatus: input.runtimeStatus,
      statusReason: input.reason,
      statusMessage: input.message,
      statusSource: "system",
      statusUpdatedAt: now,
      statusCooldownUntil: input.cooldownUntil,
      rateLimitStrike: input.rateLimitStrike ?? target.observation?.rateLimitStrike ?? 0,
      cooldownStrike: input.cooldownStrike ?? target.observation?.cooldownStrike ?? 0,
      recentErrorCount: (target.observation?.recentErrorCount ?? 0) + 1,
      lastErrorAt: now,
      lastErrorCode: input.code ?? "provider_error",
      lastErrorMessage: input.message,
      updatedAt: now
    };
    if (target.observation) {
      this.db.update(managedAccountEndpointModelsTable)
        .set(values)
        .where(eq(managedAccountEndpointModelsTable.id, target.observation.id))
        .run();
    } else {
      this.db.insert(managedAccountEndpointModelsTable).values({
        accountId: target.account.id,
        endpointId: target.endpoint.id,
        managedModelId: target.model.id,
        ...values,
        createdAt: now
      }).run();
    }
    return this.getAccountEndpointModel(providerKey, accountKey, endpointKey, modelKey);
  }

  public markAccountEndpointModelSuccess(
    providerKey: string,
    accountKey: string,
    endpointKey: string,
    modelKey: string,
    clearCounters: boolean
  ): ManagedAccountEndpointModelRow | null {
    const target = this.getAccountEndpointModelTarget(
      providerKey,
      accountKey,
      endpointKey,
      modelKey
    );
    if (!target) {
      return null;
    }
    const now = nowIso();
    const values = {
      runtimeStatus: "normal",
      statusReason: null,
      statusMessage: null,
      statusSource: "system",
      statusUpdatedAt: now,
      statusCooldownUntil: null,
      rateLimitStrike: clearCounters ? 0 : target.observation?.rateLimitStrike ?? 0,
      cooldownStrike: clearCounters ? 0 : target.observation?.cooldownStrike ?? 0,
      recentErrorCount: clearCounters ? 0 : target.observation?.recentErrorCount ?? 0,
      lastSuccessAt: now,
      updatedAt: now
    };
    if (target.observation) {
      this.db.update(managedAccountEndpointModelsTable)
        .set(values)
        .where(eq(managedAccountEndpointModelsTable.id, target.observation.id))
        .run();
    } else {
      this.db.insert(managedAccountEndpointModelsTable).values({
        accountId: target.account.id,
        endpointId: target.endpoint.id,
        managedModelId: target.model.id,
        ...values,
        createdAt: now
      }).run();
    }
    return this.getAccountEndpointModel(providerKey, accountKey, endpointKey, modelKey);
  }

  public clearAccountEndpointModelStatus(
    providerKey: string,
    accountKey: string,
    endpointKey: string,
    modelKey: string
  ): boolean {
    const target = this.getAccountEndpointModelTarget(
      providerKey,
      accountKey,
      endpointKey,
      modelKey
    );
    if (!target?.observation) {
      return false;
    }
    return this.db.delete(managedAccountEndpointModelsTable)
      .where(eq(managedAccountEndpointModelsTable.id, target.observation.id))
      .run().changes > 0;
  }

  public recordAccountEndpointModelClientError(
    providerKey: string,
    accountKey: string,
    endpointKey: string,
    modelKey: string,
    input: { code?: string; message: string }
  ): ManagedAccountEndpointModelRow | null {
    const target = this.getAccountEndpointModelTarget(
      providerKey,
      accountKey,
      endpointKey,
      modelKey
    );
    if (!target) {
      return null;
    }
    const now = nowIso();
    if (target.observation) {
      this.db.update(managedAccountEndpointModelsTable)
        .set({
          lastErrorAt: now,
          lastErrorCode: input.code ?? "request_invalid",
          lastErrorMessage: input.message,
          updatedAt: now
        })
        .where(eq(managedAccountEndpointModelsTable.id, target.observation.id))
        .run();
    } else {
      this.db.insert(managedAccountEndpointModelsTable).values({
        accountId: target.account.id,
        endpointId: target.endpoint.id,
        managedModelId: target.model.id,
        runtimeStatus: "normal",
        statusSource: "system",
        lastErrorAt: now,
        lastErrorCode: input.code ?? "request_invalid",
        lastErrorMessage: input.message,
        createdAt: now,
        updatedAt: now
      }).run();
    }
    return this.getAccountEndpointModel(providerKey, accountKey, endpointKey, modelKey);
  }

  public applyAccountModelFailure(
    providerKey: string,
    accountKey: string,
    modelKey: string,
    input: {
      runtimeStatus: "rate_limited" | "cooling_down" | "abnormal";
      reason: string;
      cooldownUntil: string | null;
      rateLimitStrike?: number;
      cooldownStrike?: number;
      code?: string;
      message: string;
    }
  ): ManagedAccountModelRow | null {
    const accountModel = this.getAccountModel(providerKey, accountKey, modelKey);
    if (!accountModel) {
      return null;
    }
    const now = nowIso();
    this.db.update(managedAccountModelsTable)
      .set({
        runtimeStatus: input.runtimeStatus,
        statusReason: input.reason,
        statusMessage: input.message,
        statusSource: "system",
        statusUpdatedAt: now,
        statusCooldownUntil: input.cooldownUntil,
        rateLimitStrike: input.rateLimitStrike ?? accountModel.rateLimitStrike,
        cooldownStrike: input.cooldownStrike ?? accountModel.cooldownStrike,
        recentErrorCount: accountModel.recentErrorCount + 1,
        lastErrorAt: now,
        lastErrorCode: input.code ?? "provider_error",
        lastErrorMessage: input.message
      })
      .where(eq(managedAccountModelsTable.id, accountModel.id))
      .run();
    return this.db.select().from(managedAccountModelsTable)
      .where(eq(managedAccountModelsTable.id, accountModel.id))
      .get() ?? null;
  }

  public markAccountModelSuccess(
    providerKey: string,
    accountKey: string,
    modelKey: string,
    clearCounters: boolean
  ): ManagedAccountModelRow | null {
    const accountModel = this.getAccountModel(providerKey, accountKey, modelKey);
    if (!accountModel) {
      return null;
    }
    if (
      accountModel.runtimeStatus === "abnormal" ||
      accountModel.runtimeStatus === "disabled" ||
      accountModel.statusReason === "rate_limited_permanent" ||
      accountModel.statusReason?.endsWith("_permanent")
    ) {
      return accountModel;
    }
    const now = nowIso();
    this.db.update(managedAccountModelsTable)
      .set({
        runtimeStatus: "normal",
        statusReason: null,
        statusMessage: null,
        statusSource: "system",
        statusUpdatedAt: now,
        statusCooldownUntil: null,
        rateLimitStrike: clearCounters ? 0 : accountModel.rateLimitStrike,
        cooldownStrike: clearCounters ? 0 : accountModel.cooldownStrike,
        recentErrorCount: clearCounters ? 0 : accountModel.recentErrorCount
      })
      .where(eq(managedAccountModelsTable.id, accountModel.id))
      .run();
    return this.db.select().from(managedAccountModelsTable)
      .where(eq(managedAccountModelsTable.id, accountModel.id))
      .get() ?? null;
  }

  public recordAccountModelClientError(
    providerKey: string,
    accountKey: string,
    modelKey: string,
    input: { code?: string; message: string }
  ): ManagedAccountModelRow | null {
    const accountModel = this.getAccountModel(providerKey, accountKey, modelKey);
    if (!accountModel) {
      return null;
    }
    const now = nowIso();
    this.db.update(managedAccountModelsTable)
      .set({
        lastErrorAt: now,
        lastErrorCode: input.code ?? "request_invalid",
        lastErrorMessage: input.message
      })
      .where(eq(managedAccountModelsTable.id, accountModel.id))
      .run();
    return this.db.select().from(managedAccountModelsTable)
      .where(eq(managedAccountModelsTable.id, accountModel.id))
      .get() ?? null;
  }

  public setModelEnabled(
    providerKey: string,
    modelKey: string,
    enabled: boolean
  ): ManagedModelRow | null {
    const model = this.getModelByProviderAndKey(providerKey, modelKey);
    if (!model) {
      return null;
    }
    const now = nowIso();
    if (enabled) {
      this.db.update(managedModelsTable)
        .set({
          enabled: true,
          runtimeStatus: "normal",
          statusReason: null,
          statusMessage: null,
          statusSource: "manual",
          statusUpdatedAt: now,
          statusCooldownUntil: null,
          rateLimitStrike: 0,
          cooldownStrike: 0,
          recentErrorCount: 0,
          updatedAt: now
        })
        .where(eq(managedModelsTable.id, model.id))
        .run();
      this.db.update(managedAccountModelsTable)
        .set({
          enabled: true,
          runtimeStatus: "normal",
          statusReason: null,
          statusMessage: null,
          statusSource: "manual",
          statusUpdatedAt: now,
          statusCooldownUntil: null,
          rateLimitStrike: 0,
          cooldownStrike: 0,
          recentErrorCount: 0
        })
        .where(eq(managedAccountModelsTable.managedModelId, model.id))
        .run();
    } else {
      this.db.update(managedModelsTable)
        .set({
          enabled: false,
          updatedAt: now
        })
        .where(eq(managedModelsTable.id, model.id))
        .run();
    }
    return this.db.select().from(managedModelsTable).where(eq(managedModelsTable.id, model.id)).get() ?? null;
  }

  public static toApiKeyHint(apiKey: string): string {
    return keyHintFromApiKey(apiKey);
  }
}
