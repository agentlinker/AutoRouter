import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const managedProvidersTable = sqliteTable("managed_providers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerKey: text("provider_key").notNull(),
  displayName: text("display_name").notNull(),
  adapterType: text("adapter_type").notNull(),
  baseUrl: text("base_url").notNull(),
  websiteUrl: text("website_url"),
  providerKind: text("provider_kind").notNull().default("custom"),
  modelAvailabilityScope: text("model_availability_scope").notNull().default("per_account"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  runtimeStatus: text("runtime_status").notNull().default("normal"),
  statusReason: text("status_reason"),
  statusMessage: text("status_message"),
  statusSource: text("status_source").notNull().default("system"),
  statusUpdatedAt: text("status_updated_at"),
  statusCooldownUntil: text("status_cooldown_until"),
  recentErrorCount: integer("recent_error_count").notNull().default(0),
  priority: integer("priority").notNull().default(0),
  trustLevel: text("trust_level").notNull().default("low"),
  privacyLevel: text("privacy_level").notNull().default("public_only"),
  usageTrust: text("usage_trust").notNull().default("low"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => ({
  providerKeyUnique: uniqueIndex("managed_providers_provider_key_unique").on(table.providerKey)
}));

export const managedProviderCredentialsTable = sqliteTable("managed_provider_credentials", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId: integer("provider_id").notNull(),
  accountKey: text("account_key").notNull().default("default"),
  endpointId: integer("endpoint_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  runtimeStatus: text("runtime_status").notNull().default("normal"),
  statusReason: text("status_reason"),
  statusMessage: text("status_message"),
  statusSource: text("status_source").notNull().default("system"),
  statusUpdatedAt: text("status_updated_at"),
  statusCooldownUntil: text("status_cooldown_until"),
  /** 错误冷却阶梯计数，独立于 429 的 rate_limit_strike */
  cooldownStrike: integer("cooldown_strike").notNull().default(0),
  recentErrorCount: integer("recent_error_count").notNull().default(0),
  expiresAt: text("expires_at"),
  quotaJson: text("quota_json"),
  lastErrorAt: text("last_error_at"),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  keyHint: text("key_hint"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => ({
  providerAccountUnique: uniqueIndex("managed_provider_credentials_provider_account_unique").on(
    table.providerId,
    table.accountKey
  )
}));

export const managedProviderEndpointsTable = sqliteTable("managed_provider_endpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId: integer("provider_id").notNull(),
  endpointKey: text("endpoint_key").notNull(),
  protocol: text("protocol").notNull().default("openai"),
  adapterType: text("adapter_type").notNull(),
  baseUrl: text("base_url").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  supportsStreaming: integer("supports_streaming", { mode: "boolean" }).notNull().default(true),
  supportsTools: integer("supports_tools", { mode: "boolean" }).notNull().default(false),
  supportsJsonMode: integer("supports_json_mode", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => ({
  providerEndpointUnique: uniqueIndex("managed_provider_endpoints_provider_endpoint_unique").on(
    table.providerId,
    table.endpointKey
  )
}));

export const logicalModelsTable = sqliteTable("logical_models", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  logicalName: text("logical_name").notNull(),
  displayName: text("display_name"),
  openrouterSlug: text("openrouter_slug"),
  aliasesJson: text("aliases_json"),
  contextWindow: integer("context_window"),
  supportsStreaming: integer("supports_streaming", { mode: "boolean" }).notNull().default(true),
  supportsTools: integer("supports_tools", { mode: "boolean" }).notNull().default(true),
  supportsJsonMode: integer("supports_json_mode", { mode: "boolean" }).notNull().default(false),
  inputModalitiesJson: text("input_modalities_json"),
  pricingJson: text("pricing_json"),
  rawMetadataJson: text("raw_metadata_json"),
  metadataSource: text("metadata_source").notNull().default("manual"),
  metadataConfidence: text("metadata_confidence").notNull().default("low"),
  notes: text("notes"),
  fetchedAt: text("fetched_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => ({
  logicalNameUnique: uniqueIndex("logical_models_logical_name_unique").on(table.logicalName)
}));

export const managedModelsTable = sqliteTable("managed_models", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId: integer("provider_id").notNull(),
  endpointId: integer("endpoint_id"),
  logicalModelId: integer("logical_model_id"),
  modelKey: text("model_key").notNull(),
  providerModelId: text("provider_model_id").notNull(),
  modelName: text("model_name").notNull(),
  contextWindow: integer("context_window"),
  supportsStreaming: integer("supports_streaming", { mode: "boolean" }).notNull().default(true),
  supportsTools: integer("supports_tools", { mode: "boolean" }).notNull().default(false),
  supportsJsonMode: integer("supports_json_mode", { mode: "boolean" }).notNull().default(false),
  pricingJson: text("pricing_json"),
  rawMetadataJson: text("raw_metadata_json"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  runtimeStatus: text("runtime_status").notNull().default("normal"),
  statusReason: text("status_reason"),
  statusMessage: text("status_message"),
  statusSource: text("status_source").notNull().default("system"),
  statusUpdatedAt: text("status_updated_at"),
  statusCooldownUntil: text("status_cooldown_until"),
  rateLimitStrike: integer("rate_limit_strike").notNull().default(0),
  /** 错误冷却阶梯计数（model_unavailable），独立于 429 的 rate_limit_strike */
  cooldownStrike: integer("cooldown_strike").notNull().default(0),
  recentErrorCount: integer("recent_error_count").notNull().default(0),
  lastErrorAt: text("last_error_at"),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  contextWindowOverride: integer("context_window_override"),
  supportsToolsOverride: integer("supports_tools_override", { mode: "boolean" }),
  supportsStreamingOverride: integer("supports_streaming_override", { mode: "boolean" }),
  supportsJsonModeOverride: integer("supports_json_mode_override", { mode: "boolean" }),
  pricingJsonOverride: text("pricing_json_override"),
  manualOverrideJson: text("manual_override_json"),
  discoveredAt: text("discovered_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => ({
  providerModelUnique: uniqueIndex("managed_models_provider_model_unique").on(
    table.providerId,
    table.providerModelId
  ),
  modelKeyUnique: uniqueIndex("managed_models_model_key_unique").on(
    table.providerId,
    table.modelKey
  )
}));

export const managedAccountModelsTable = sqliteTable("managed_account_models", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull(),
  managedModelId: integer("managed_model_id").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  runtimeStatus: text("runtime_status").notNull().default("normal"),
  statusReason: text("status_reason"),
  statusMessage: text("status_message"),
  statusSource: text("status_source").notNull().default("system"),
  statusUpdatedAt: text("status_updated_at"),
  statusCooldownUntil: text("status_cooldown_until"),
  rateLimitStrike: integer("rate_limit_strike").notNull().default(0),
  cooldownStrike: integer("cooldown_strike").notNull().default(0),
  recentErrorCount: integer("recent_error_count").notNull().default(0),
  lastErrorAt: text("last_error_at"),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  discoveredAt: text("discovered_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull()
}, (table) => ({
  accountModelUnique: uniqueIndex("managed_account_models_account_model_unique").on(
    table.accountId,
    table.managedModelId
  )
}));

export const modelSyncRunsTable = sqliteTable("model_sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId: integer("provider_id").notNull(),
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  discoveredCount: integer("discovered_count").notNull().default(0)
});


export const appSettingsTable = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const routeTracesTable = sqliteTable("route_traces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  traceId: text("trace_id").notNull(),
  timestamp: text("timestamp").notNull(),
  sessionId: text("session_id"),
  requestedModel: text("requested_model").notNull(),
  normalizedModel: text("normalized_model").notNull(),
  promptHash: text("prompt_hash").notNull(),
  stream: integer("stream", { mode: "boolean" }).notNull().default(false),
  hasTools: integer("has_tools", { mode: "boolean" }).notNull().default(false),
  privacyLevel: text("privacy_level").notNull(),
  contextTokensEst: integer("context_tokens_est").notNull().default(0),
  requestedContextWindow: integer("requested_context_window"),
  selectedRouteId: text("selected_route_id"),
  selectedEndpoint: text("selected_endpoint"),
  selectedPlatform: text("selected_platform"),
  selectedProvider: text("selected_provider"),
  selectedAccountHash: text("selected_account_hash"),
  selectedModelId: text("selected_model_id"),
  selectedModel: text("selected_model"),
  selectedScore: real("selected_score"),
  policyHitsJson: text("policy_hits_json").notNull(),
  candidatesJson: text("candidates_json").notNull(),
  filteredJson: text("filtered_json").notNull(),
  attemptsJson: text("attempts_json").notNull().default("[]"),
  fallbacksJson: text("fallbacks_json").notNull(),
  executionStatus: text("execution_status").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  executionError: text("execution_error"),
  estimatedCostUsd: real("estimated_cost_usd"),
  actualCostUsd: real("actual_cost_usd"),
  priceConfidence: text("price_confidence").notNull(),
  feedbackLabel: text("feedback_label"),
  feedbackSource: text("feedback_source"),
  feedbackAt: text("feedback_at"),
  trainingSplit: text("training_split"),
  tagsJson: text("tags_json"),
  createdAt: text("created_at").notNull()
}, (table) => ({
  traceIdUnique: uniqueIndex("route_traces_trace_id_unique").on(table.traceId),
  timestampIndex: uniqueIndex("route_traces_timestamp_trace_id_unique").on(table.timestamp, table.traceId)
}));

export const schema = {
  managedProvidersTable,
  managedProviderCredentialsTable,
  managedProviderEndpointsTable,
  logicalModelsTable,
  managedModelsTable,
  managedAccountModelsTable,
  modelSyncRunsTable,
  appSettingsTable,
  routeTracesTable
};

export type ManagedProviderRow = typeof managedProvidersTable.$inferSelect;
export type ManagedCredentialRow = typeof managedProviderCredentialsTable.$inferSelect;
export type ManagedProviderEndpointRow = typeof managedProviderEndpointsTable.$inferSelect;
export type LogicalModelRow = typeof logicalModelsTable.$inferSelect;
export type ManagedModelRow = typeof managedModelsTable.$inferSelect;
export type ManagedAccountModelRow = typeof managedAccountModelsTable.$inferSelect;
export type ModelSyncRunRow = typeof modelSyncRunsTable.$inferSelect;
export type RouteTraceRow = typeof routeTracesTable.$inferSelect;

export type AppSettingsRow = typeof appSettingsTable.$inferSelect;
