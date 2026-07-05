import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const managedProvidersTable = sqliteTable("managed_providers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerKey: text("provider_key").notNull(),
  displayName: text("display_name").notNull(),
  adapterType: text("adapter_type").notNull(),
  baseUrl: text("base_url").notNull(),
  websiteUrl: text("website_url"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
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
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  keyHint: text("key_hint"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
}, (table) => ({
  providerUnique: uniqueIndex("managed_provider_credentials_provider_id_unique").on(table.providerId)
}));

export const managedModelsTable = sqliteTable("managed_models", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId: integer("provider_id").notNull(),
  modelKey: text("model_key").notNull(),
  providerModelId: text("provider_model_id").notNull(),
  modelName: text("model_name").notNull(),
  contextWindow: integer("context_window"),
  supportsStreaming: integer("supports_streaming", { mode: "boolean" }).notNull().default(true),
  supportsTools: integer("supports_tools", { mode: "boolean" }).notNull().default(false),
  supportsJsonMode: integer("supports_json_mode", { mode: "boolean" }).notNull().default(false),
  pricingJson: text("pricing_json"),
  rawMetadataJson: text("raw_metadata_json"),
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

export const modelSyncRunsTable = sqliteTable("model_sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId: integer("provider_id").notNull(),
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  discoveredCount: integer("discovered_count").notNull().default(0)
});

export const schema = {
  managedProvidersTable,
  managedProviderCredentialsTable,
  managedModelsTable,
  modelSyncRunsTable
};

export type ManagedProviderRow = typeof managedProvidersTable.$inferSelect;
export type ManagedCredentialRow = typeof managedProviderCredentialsTable.$inferSelect;
export type ManagedModelRow = typeof managedModelsTable.$inferSelect;
export type ModelSyncRunRow = typeof modelSyncRunsTable.$inferSelect;
