import type Database from "better-sqlite3";

export function runMigrations(sqlite: Database.Database) {
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS managed_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      base_url TEXT NOT NULL,
      website_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      trust_level TEXT NOT NULL DEFAULT 'low',
      privacy_level TEXT NOT NULL DEFAULT 'public_only',
      usage_trust TEXT NOT NULL DEFAULT 'low',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS managed_provider_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL UNIQUE,
      api_key_encrypted TEXT NOT NULL,
      key_hint TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES managed_providers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS managed_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      model_key TEXT NOT NULL,
      provider_model_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      context_window INTEGER,
      supports_streaming INTEGER NOT NULL DEFAULT 1,
      supports_tools INTEGER NOT NULL DEFAULT 0,
      supports_json_mode INTEGER NOT NULL DEFAULT 0,
      pricing_json TEXT,
      raw_metadata_json TEXT,
      discovered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES managed_providers(id) ON DELETE CASCADE,
      UNIQUE (provider_id, provider_model_id),
      UNIQUE (provider_id, model_key)
    );

    CREATE TABLE IF NOT EXISTS model_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      discovered_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (provider_id) REFERENCES managed_providers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS route_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL UNIQUE,
      timestamp TEXT NOT NULL,
      session_id TEXT,
      requested_model TEXT NOT NULL,
      normalized_model TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      stream INTEGER NOT NULL DEFAULT 0,
      has_tools INTEGER NOT NULL DEFAULT 0,
      privacy_level TEXT NOT NULL,
      context_tokens_est INTEGER NOT NULL DEFAULT 0,
      selected_route_id TEXT,
      selected_endpoint TEXT,
      selected_platform TEXT,
      selected_provider TEXT,
      selected_account_hash TEXT,
      selected_model_id TEXT,
      selected_model TEXT,
      selected_score REAL,
      policy_hits_json TEXT NOT NULL,
      candidates_json TEXT NOT NULL,
      filtered_json TEXT NOT NULL,
      fallbacks_json TEXT NOT NULL,
      execution_status TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      execution_error TEXT,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      price_confidence TEXT NOT NULL,
      feedback_label TEXT,
      feedback_source TEXT,
      feedback_at TEXT,
      training_split TEXT,
      tags_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS route_traces_timestamp_trace_id_unique
      ON route_traces (timestamp, trace_id);
  `);

  const providerColumns = sqlite.pragma("table_info(managed_providers)") as Array<{
    name: string;
  }>;
  const hasWebsiteUrl = providerColumns.some((column) => column.name === "website_url");

  if (!hasWebsiteUrl) {
    sqlite.exec("ALTER TABLE managed_providers ADD COLUMN website_url TEXT;");
  }

  const routeTraceColumns = sqlite.pragma("table_info(route_traces)") as Array<{
    name: string;
  }>;
  const routeTraceColumnDefinitions: Array<{ name: string; sql: string }> = [
    { name: "context_tokens_est", sql: "ALTER TABLE route_traces ADD COLUMN context_tokens_est INTEGER NOT NULL DEFAULT 0;" },
    { name: "selected_score", sql: "ALTER TABLE route_traces ADD COLUMN selected_score REAL;" },
    { name: "feedback_label", sql: "ALTER TABLE route_traces ADD COLUMN feedback_label TEXT;" },
    { name: "feedback_source", sql: "ALTER TABLE route_traces ADD COLUMN feedback_source TEXT;" },
    { name: "feedback_at", sql: "ALTER TABLE route_traces ADD COLUMN feedback_at TEXT;" },
    { name: "training_split", sql: "ALTER TABLE route_traces ADD COLUMN training_split TEXT;" },
    { name: "tags_json", sql: "ALTER TABLE route_traces ADD COLUMN tags_json TEXT;" }
  ];

  for (const definition of routeTraceColumnDefinitions) {
    if (!routeTraceColumns.some((column) => column.name === definition.name)) {
      sqlite.exec(definition.sql);
    }
  }
}
