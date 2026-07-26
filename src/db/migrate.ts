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


  const managedProviderColumns = sqlite.pragma("table_info(managed_providers)") as Array<{
    name: string;
  }>;
  const managedProviderColumnDefinitions: Array<{ name: string; sql: string }> = [
    { name: "runtime_status", sql: "ALTER TABLE managed_providers ADD COLUMN runtime_status TEXT NOT NULL DEFAULT 'normal';" },
    { name: "status_reason", sql: "ALTER TABLE managed_providers ADD COLUMN status_reason TEXT;" },
    { name: "status_message", sql: "ALTER TABLE managed_providers ADD COLUMN status_message TEXT;" },
    { name: "status_source", sql: "ALTER TABLE managed_providers ADD COLUMN status_source TEXT NOT NULL DEFAULT 'system';" },
    { name: "status_updated_at", sql: "ALTER TABLE managed_providers ADD COLUMN status_updated_at TEXT;" },
    { name: "status_cooldown_until", sql: "ALTER TABLE managed_providers ADD COLUMN status_cooldown_until TEXT;" },
    { name: "recent_error_count", sql: "ALTER TABLE managed_providers ADD COLUMN recent_error_count INTEGER NOT NULL DEFAULT 0;" }
  ];
  for (const definition of managedProviderColumnDefinitions) {
    if (!managedProviderColumns.some((column) => column.name === definition.name)) {
      sqlite.exec(definition.sql);
    }
  }

  const managedModelRuntimeColumns = sqlite.pragma("table_info(managed_models)") as Array<{
    name: string;
  }>;
  const managedModelRuntimeDefinitions: Array<{ name: string; sql: string }> = [
    { name: "runtime_status", sql: "ALTER TABLE managed_models ADD COLUMN runtime_status TEXT NOT NULL DEFAULT 'normal';" },
    { name: "status_reason", sql: "ALTER TABLE managed_models ADD COLUMN status_reason TEXT;" },
    { name: "status_message", sql: "ALTER TABLE managed_models ADD COLUMN status_message TEXT;" },
    { name: "status_source", sql: "ALTER TABLE managed_models ADD COLUMN status_source TEXT NOT NULL DEFAULT 'system';" },
    { name: "status_updated_at", sql: "ALTER TABLE managed_models ADD COLUMN status_updated_at TEXT;" },
    { name: "status_cooldown_until", sql: "ALTER TABLE managed_models ADD COLUMN status_cooldown_until TEXT;" },
    { name: "rate_limit_strike", sql: "ALTER TABLE managed_models ADD COLUMN rate_limit_strike INTEGER NOT NULL DEFAULT 0;" },
    { name: "recent_error_count", sql: "ALTER TABLE managed_models ADD COLUMN recent_error_count INTEGER NOT NULL DEFAULT 0;" },
    { name: "last_error_at", sql: "ALTER TABLE managed_models ADD COLUMN last_error_at TEXT;" },
    { name: "last_error_code", sql: "ALTER TABLE managed_models ADD COLUMN last_error_code TEXT;" },
    { name: "last_error_message", sql: "ALTER TABLE managed_models ADD COLUMN last_error_message TEXT;" }
  ];
  for (const definition of managedModelRuntimeDefinitions) {
    if (!managedModelRuntimeColumns.some((column) => column.name === definition.name)) {
      sqlite.exec(definition.sql);
    }
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);


  // Multi-account provider fields
  const managedProviderKindColumns = sqlite.pragma("table_info(managed_providers)") as Array<{
    name: string;
  }>;
  const managedProviderKindDefinitions: Array<{ name: string; sql: string }> = [
    { name: "provider_kind", sql: "ALTER TABLE managed_providers ADD COLUMN provider_kind TEXT NOT NULL DEFAULT 'custom';" },
    {
      name: "model_availability_scope",
      sql: "ALTER TABLE managed_providers ADD COLUMN model_availability_scope TEXT NOT NULL DEFAULT 'per_account';"
    }
  ];
  for (const definition of managedProviderKindDefinitions) {
    if (!managedProviderKindColumns.some((column) => column.name === definition.name)) {
      sqlite.exec(definition.sql);
    }
  }

  const credentialColumns = sqlite.pragma("table_info(managed_provider_credentials)") as Array<{
    name: string;
  }>;
  const hasAccountKey = credentialColumns.some((column) => column.name === "account_key");
  if (!hasAccountKey) {
    sqlite.exec(`
      CREATE TABLE managed_provider_credentials_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id INTEGER NOT NULL,
        account_key TEXT NOT NULL DEFAULT 'default',
        endpoint_id INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        runtime_status TEXT NOT NULL DEFAULT 'normal',
        status_reason TEXT,
        status_message TEXT,
        status_source TEXT NOT NULL DEFAULT 'system',
        status_updated_at TEXT,
        status_cooldown_until TEXT,
        recent_error_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        quota_json TEXT,
        last_error_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        api_key_encrypted TEXT NOT NULL,
        key_hint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (provider_id) REFERENCES managed_providers(id) ON DELETE CASCADE,
        UNIQUE (provider_id, account_key)
      );

      INSERT INTO managed_provider_credentials_v2 (
        id,
        provider_id,
        account_key,
        endpoint_id,
        enabled,
        runtime_status,
        status_reason,
        status_message,
        status_source,
        status_updated_at,
        status_cooldown_until,
        recent_error_count,
        api_key_encrypted,
        key_hint,
        created_at,
        updated_at
      )
      SELECT
        credentials.id,
        credentials.provider_id,
        'default',
        (
          SELECT endpoints.id
          FROM managed_provider_endpoints AS endpoints
          WHERE endpoints.provider_id = credentials.provider_id
          ORDER BY
            CASE WHEN endpoints.endpoint_key = 'default' THEN 0 ELSE 1 END,
            endpoints.id ASC
          LIMIT 1
        ),
        1,
        CASE
          WHEN providers.runtime_status = 'disabled'
            AND providers.status_reason = 'auth_failed'
          THEN 'disabled'
          ELSE 'normal'
        END,
        CASE
          WHEN providers.runtime_status = 'disabled'
            AND providers.status_reason = 'auth_failed'
          THEN providers.status_reason
          ELSE NULL
        END,
        CASE
          WHEN providers.runtime_status = 'disabled'
            AND providers.status_reason = 'auth_failed'
          THEN providers.status_message
          ELSE NULL
        END,
        CASE
          WHEN providers.runtime_status = 'disabled'
            AND providers.status_reason = 'auth_failed'
          THEN COALESCE(providers.status_source, 'system')
          ELSE 'system'
        END,
        CASE
          WHEN providers.runtime_status = 'disabled'
            AND providers.status_reason = 'auth_failed'
          THEN providers.status_updated_at
          ELSE NULL
        END,
        NULL,
        0,
        credentials.api_key_encrypted,
        credentials.key_hint,
        credentials.created_at,
        credentials.updated_at
      FROM managed_provider_credentials AS credentials
      LEFT JOIN managed_providers AS providers
        ON providers.id = credentials.provider_id;

      DROP TABLE managed_provider_credentials;
      ALTER TABLE managed_provider_credentials_v2 RENAME TO managed_provider_credentials;

      UPDATE managed_providers
      SET
        runtime_status = 'normal',
        status_reason = NULL,
        status_message = NULL,
        status_source = 'system',
        status_updated_at = NULL,
        status_cooldown_until = NULL,
        recent_error_count = 0
      WHERE runtime_status = 'disabled'
        AND status_reason = 'auth_failed';
    `);
  } else {
    const credentialColumnDefinitions: Array<{ name: string; sql: string }> = [
      { name: "endpoint_id", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN endpoint_id INTEGER;" },
      { name: "enabled", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;" },
      { name: "runtime_status", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN runtime_status TEXT NOT NULL DEFAULT 'normal';" },
      { name: "status_reason", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN status_reason TEXT;" },
      { name: "status_message", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN status_message TEXT;" },
      { name: "status_source", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN status_source TEXT NOT NULL DEFAULT 'system';" },
      { name: "status_updated_at", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN status_updated_at TEXT;" },
      { name: "status_cooldown_until", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN status_cooldown_until TEXT;" },
      { name: "recent_error_count", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN recent_error_count INTEGER NOT NULL DEFAULT 0;" },
      { name: "expires_at", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN expires_at TEXT;" },
      { name: "quota_json", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN quota_json TEXT;" },
      { name: "last_error_at", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN last_error_at TEXT;" },
      { name: "last_error_code", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN last_error_code TEXT;" },
      { name: "last_error_message", sql: "ALTER TABLE managed_provider_credentials ADD COLUMN last_error_message TEXT;" }
    ];
    for (const definition of credentialColumnDefinitions) {
      if (!credentialColumns.some((column) => column.name === definition.name)) {
        sqlite.exec(definition.sql);
      }
    }
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS managed_provider_credentials_provider_account_unique
        ON managed_provider_credentials (provider_id, account_key);
    `);
  }


  // Backfill official provider kind/scope from known official endpoint base urls.
  sqlite.exec(`
    UPDATE managed_providers
    SET
      provider_kind = 'official',
      model_availability_scope = 'shared_by_provider'
    WHERE id IN (
      SELECT DISTINCT provider_id
      FROM managed_provider_endpoints
      WHERE lower(rtrim(base_url, '/')) IN (
        'https://open.bigmodel.cn/api/paas/v4',
        'https://open.bigmodel.cn/api/anthropic',
        'https://token-plan-cn.xiaomimimo.com/v1',
        'https://token-plan-cn.xiaomimimo.com/anthropic',
        'https://token-plan-sgp.xiaomimimo.com/v1',
        'https://token-plan-sgp.xiaomimimo.com/anthropic',
        'https://ark.cn-beijing.volces.com/api/coding/v3',
        'https://ark.cn-beijing.volces.com/api/coding',
        'https://api.longcat.chat/openai',
        'https://api.longcat.chat/anthropic'
      )
    );
  `);


  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS managed_account_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      managed_model_id INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      discovered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES managed_provider_credentials(id) ON DELETE CASCADE,
      FOREIGN KEY (managed_model_id) REFERENCES managed_models(id) ON DELETE CASCADE,
      UNIQUE (account_id, managed_model_id)
    );
  `);

  // For per_account providers, seed default account model availability from existing models.
  sqlite.exec(`
    INSERT OR IGNORE INTO managed_account_models (
      account_id,
      managed_model_id,
      enabled,
      discovered_at,
      last_seen_at
    )
    SELECT
      credentials.id,
      models.id,
      1,
      models.discovered_at,
      models.updated_at
    FROM managed_provider_credentials AS credentials
    INNER JOIN managed_providers AS providers
      ON providers.id = credentials.provider_id
    INNER JOIN managed_models AS models
      ON models.provider_id = providers.id
    WHERE providers.model_availability_scope = 'per_account'
      AND credentials.account_key = 'default';
  `);

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
