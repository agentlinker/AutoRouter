import type Database from "better-sqlite3";

function toLogicalModelName(modelName: string): string {
  const trimmed = modelName.trim();
  const basename = trimmed.split(/[/:]/).filter(Boolean).at(-1) ?? trimmed;
  return basename
    .replace(/[_\s]+/g, "-")
    .replace(/([a-z])([0-9])/gi, "$1-$2")
    .replace(/([0-9])([a-z])/gi, "$1-$2")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function parseAliases(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function serializeAliases(values: Array<string | null | undefined>): string | null {
  const aliases = Array.from(new Set(
    values.flatMap((value) => {
      if (!value) {
        return [];
      }
      const trimmed = value.trim();
      return trimmed ? [trimmed] : [];
    })
  ));

  return aliases.length > 0 ? JSON.stringify(aliases) : null;
}

function metadataRank(source: string | null | undefined): number {
  switch (source) {
    case "manual":
      return 4;
    case "openrouter":
      return 3;
    case "provider_derived":
      return 2;
    case "estimated":
      return 1;
    default:
      return 0;
  }
}

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

    CREATE TABLE IF NOT EXISTS managed_provider_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      endpoint_key TEXT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'openai',
      adapter_type TEXT NOT NULL,
      base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      supports_streaming INTEGER NOT NULL DEFAULT 1,
      supports_tools INTEGER NOT NULL DEFAULT 0,
      supports_json_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES managed_providers(id) ON DELETE CASCADE,
      UNIQUE (provider_id, endpoint_key)
    );

    CREATE TABLE IF NOT EXISTS managed_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      endpoint_id INTEGER,
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
      attempts_json TEXT NOT NULL DEFAULT '[]',
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

  const modelColumns = sqlite.pragma("table_info(managed_models)") as Array<{
    name: string;
  }>;
  if (!modelColumns.some((column) => column.name === "endpoint_id")) {
    sqlite.exec("ALTER TABLE managed_models ADD COLUMN endpoint_id INTEGER;");
  }

  sqlite.exec(`
    INSERT OR IGNORE INTO managed_provider_endpoints (
      provider_id,
      endpoint_key,
      protocol,
      adapter_type,
      base_url,
      enabled,
      supports_streaming,
      supports_tools,
      supports_json_mode,
      created_at,
      updated_at
    )
    SELECT
      id,
      'default',
      CASE WHEN adapter_type = 'anthropic' THEN 'anthropic' ELSE 'openai' END,
      adapter_type,
      base_url,
      enabled,
      1,
      0,
      0,
      created_at,
      updated_at
    FROM managed_providers
    WHERE NOT EXISTS (
      SELECT 1
      FROM managed_provider_endpoints
      WHERE managed_provider_endpoints.provider_id = managed_providers.id
    );

    UPDATE managed_models
    SET endpoint_id = (
      SELECT managed_provider_endpoints.id
      FROM managed_provider_endpoints
      WHERE managed_provider_endpoints.provider_id = managed_models.provider_id
        AND managed_provider_endpoints.endpoint_key = 'default'
    )
    WHERE endpoint_id IS NULL;
  `);

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
    { name: "tags_json", sql: "ALTER TABLE route_traces ADD COLUMN tags_json TEXT;" },
    { name: "attempts_json", sql: "ALTER TABLE route_traces ADD COLUMN attempts_json TEXT NOT NULL DEFAULT '[]';" }
  ];

  for (const definition of routeTraceColumnDefinitions) {
    if (!routeTraceColumns.some((column) => column.name === definition.name)) {
      sqlite.exec(definition.sql);
    }
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS logical_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      logical_name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      openrouter_slug TEXT,
      aliases_json TEXT,
      context_window INTEGER,
      supports_streaming INTEGER NOT NULL DEFAULT 1,
      supports_tools INTEGER NOT NULL DEFAULT 1,
      supports_json_mode INTEGER NOT NULL DEFAULT 0,
      input_modalities_json TEXT,
      pricing_json TEXT,
      raw_metadata_json TEXT,
      metadata_source TEXT NOT NULL DEFAULT 'manual',
      metadata_confidence TEXT NOT NULL DEFAULT 'low',
      notes TEXT,
      fetched_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const managedModelColumns = sqlite.pragma("table_info(managed_models)") as Array<{
    name: string;
  }>;
  const managedModelColumnDefinitions: Array<{ name: string; sql: string }> = [
    { name: "logical_model_id", sql: "ALTER TABLE managed_models ADD COLUMN logical_model_id INTEGER;" },
    { name: "enabled", sql: "ALTER TABLE managed_models ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;" },
    { name: "context_window_override", sql: "ALTER TABLE managed_models ADD COLUMN context_window_override INTEGER;" },
    {
      name: "supports_tools_override",
      sql: "ALTER TABLE managed_models ADD COLUMN supports_tools_override INTEGER;"
    },
    {
      name: "supports_streaming_override",
      sql: "ALTER TABLE managed_models ADD COLUMN supports_streaming_override INTEGER;"
    },
    {
      name: "supports_json_mode_override",
      sql: "ALTER TABLE managed_models ADD COLUMN supports_json_mode_override INTEGER;"
    },
    {
      name: "pricing_json_override",
      sql: "ALTER TABLE managed_models ADD COLUMN pricing_json_override TEXT;"
    },
    {
      name: "manual_override_json",
      sql: "ALTER TABLE managed_models ADD COLUMN manual_override_json TEXT;"
    }
  ];

  for (const definition of managedModelColumnDefinitions) {
    if (!managedModelColumns.some((column) => column.name === definition.name)) {
      sqlite.exec(definition.sql);
    }
  }

  // Backfill logical models from provider model ids and bind all managed rows to canonical logical rows.
  const now = new Date().toISOString();
  const managedRows = sqlite
    .prepare(
      `SELECT id, provider_model_id, model_name, raw_metadata_json
       FROM managed_models
       WHERE provider_model_id IS NOT NULL AND TRIM(provider_model_id) != ''`
    )
    .all() as Array<{
      id: number;
      provider_model_id: string;
      model_name: string;
      raw_metadata_json: string | null;
    }>;

  const insertLogical = sqlite.prepare(
    `INSERT OR IGNORE INTO logical_models (
      logical_name, display_name, aliases_json, supports_streaming, supports_tools, supports_json_mode,
      metadata_source, metadata_confidence, created_at, updated_at
    ) VALUES (?, ?, ?, 1, 1, 0, 'provider_derived', 'low', ?, ?)`
  );
  const logicalByName = new Map<string, {
    logicalName: string;
    aliases: string[];
  }>();

  for (const row of managedRows) {
    const logicalName = toLogicalModelName(row.provider_model_id);
    if (!logicalName) {
      continue;
    }

    const entry = logicalByName.get(logicalName) ?? {
      logicalName,
      aliases: []
    };
    entry.aliases.push(row.provider_model_id, row.model_name);
    logicalByName.set(logicalName, entry);
    insertLogical.run(
      logicalName,
      logicalName,
      serializeAliases([row.provider_model_id, row.model_name]),
      now,
      now
    );
  }

  const selectLogicalByName = sqlite.prepare(
    `SELECT id, aliases_json
     FROM logical_models
     WHERE logical_name = ?`
  );
  const updateLogicalAliases = sqlite.prepare(
    `UPDATE logical_models
     SET aliases_json = ?, updated_at = ?
     WHERE id = ?`
  );
  const updateManagedLogical = sqlite.prepare(
    `UPDATE managed_models
     SET logical_model_id = ?, model_name = ?, updated_at = ?
     WHERE id = ?`
  );

  for (const entry of logicalByName.values()) {
    const logical = selectLogicalByName.get(entry.logicalName) as {
      id: number;
      aliases_json: string | null;
    } | undefined;
    if (!logical) {
      continue;
    }

    const aliasesJson = serializeAliases([
      ...parseAliases(logical.aliases_json),
      ...entry.aliases
    ]);
    updateLogicalAliases.run(aliasesJson, now, logical.id);
  }

  for (const row of managedRows) {
    const logicalName = toLogicalModelName(row.provider_model_id);
    const logical = selectLogicalByName.get(logicalName) as { id: number } | undefined;
    if (!logical) {
      continue;
    }
    updateManagedLogical.run(logical.id, logicalName, now, row.id);
  }

  const logicalRows = sqlite.prepare(
    `SELECT *
     FROM logical_models`
  ).all() as Array<{
    id: number;
    logical_name: string;
    display_name: string | null;
    openrouter_slug: string | null;
    aliases_json: string | null;
    context_window: number | null;
    supports_streaming: number;
    supports_tools: number;
    supports_json_mode: number;
    input_modalities_json: string | null;
    pricing_json: string | null;
    raw_metadata_json: string | null;
    metadata_source: string;
    metadata_confidence: string;
    notes: string | null;
    fetched_at: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const canonicalGroups = new Map<string, typeof logicalRows>();
  for (const row of logicalRows) {
    const canonical = toLogicalModelName(row.logical_name);
    canonicalGroups.set(canonical, [...(canonicalGroups.get(canonical) ?? []), row]);
  }

  const selectLogicalId = sqlite.prepare(
    `SELECT id FROM logical_models WHERE logical_name = ?`
  );
  const updateLogicalMetadata = sqlite.prepare(
    `UPDATE logical_models
     SET
       display_name = ?,
       openrouter_slug = ?,
       aliases_json = ?,
       context_window = ?,
       supports_streaming = ?,
       supports_tools = ?,
       supports_json_mode = ?,
       input_modalities_json = ?,
       pricing_json = ?,
       raw_metadata_json = ?,
       metadata_source = ?,
       metadata_confidence = ?,
       notes = ?,
       fetched_at = ?,
       updated_at = ?
     WHERE id = ?`
  );
  const rebindManagedLogical = sqlite.prepare(
    `UPDATE managed_models SET logical_model_id = ? WHERE logical_model_id = ?`
  );
  const deleteLogicalById = sqlite.prepare(
    `DELETE FROM logical_models WHERE id = ?`
  );

  for (const [canonical, rows] of canonicalGroups.entries()) {
    if (!canonical) {
      continue;
    }

    insertLogical.run(canonical, canonical, serializeAliases([canonical]), now, now);
    const canonicalRow = selectLogicalId.get(canonical) as { id: number } | undefined;
    if (!canonicalRow) {
      continue;
    }

    const best = rows
      .slice()
      .sort((left, right) => metadataRank(right.metadata_source) - metadataRank(left.metadata_source))[0];
    const aliasesJson = serializeAliases([
      canonical,
      ...rows.flatMap((row) => [
        row.logical_name,
        row.display_name,
        row.openrouter_slug,
        ...parseAliases(row.aliases_json)
      ])
    ]);

    updateLogicalMetadata.run(
      best.display_name && toLogicalModelName(best.display_name) !== canonical ? best.display_name : canonical,
      best.openrouter_slug,
      aliasesJson,
      best.context_window ?? (Math.max(...rows.map((row) => row.context_window ?? 0)) || null),
      rows.some((row) => row.supports_streaming === 1) ? 1 : 0,
      rows.some((row) => row.supports_tools === 1) ? 1 : 0,
      rows.some((row) => row.supports_json_mode === 1) ? 1 : 0,
      best.input_modalities_json,
      best.pricing_json,
      best.raw_metadata_json,
      best.metadata_source,
      best.metadata_confidence,
      best.notes,
      best.fetched_at,
      now,
      canonicalRow.id
    );

    for (const row of rows) {
      if (row.id === canonicalRow.id) {
        continue;
      }

      rebindManagedLogical.run(canonicalRow.id, row.id);
      deleteLogicalById.run(row.id);
    }
  }

  sqlite.exec(`
    DELETE FROM logical_models
    WHERE metadata_source = 'provider_derived'
      AND id NOT IN (
        SELECT DISTINCT logical_model_id
        FROM managed_models
        WHERE logical_model_id IS NOT NULL
      );
  `);

  // Prefer richer discovery fields onto logical skeleton when logical is still sparse.
  sqlite.exec(`
    UPDATE logical_models
    SET
      context_window = COALESCE(
        context_window,
        (
          SELECT MAX(managed_models.context_window)
          FROM managed_models
          WHERE managed_models.logical_model_id = logical_models.id
            AND managed_models.context_window IS NOT NULL
        )
      ),
      supports_tools = CASE
        WHEN EXISTS (
          SELECT 1 FROM managed_models
          WHERE managed_models.logical_model_id = logical_models.id
            AND managed_models.supports_tools = 1
        ) THEN 1
        ELSE supports_tools
      END,
      supports_json_mode = CASE
        WHEN EXISTS (
          SELECT 1 FROM managed_models
          WHERE managed_models.logical_model_id = logical_models.id
            AND managed_models.supports_json_mode = 1
        ) THEN 1
        ELSE supports_json_mode
      END,
      updated_at = '${now}'
    WHERE metadata_source = 'provider_derived';
  `);
}
