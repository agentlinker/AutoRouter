import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";

function createLegacyProviderTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE managed_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      website_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'low',
      privacy_level TEXT NOT NULL DEFAULT 'public_only',
      usage_trust TEXT NOT NULL DEFAULT 'low',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE managed_provider_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      endpoint_key TEXT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'openai',
      base_url TEXT NOT NULL,
      custom_headers_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      supports_streaming INTEGER NOT NULL DEFAULT 1,
      supports_tools INTEGER NOT NULL DEFAULT 0,
      supports_json_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES managed_providers(id) ON DELETE CASCADE,
      UNIQUE (provider_id, endpoint_key)
    );
  `);
}

describe("database migrations", () => {
  it("creates provider-scoped model catalog and account-endpoint-model observation storage", () => {
    const sqlite = new Database(":memory:");

    runMigrations(sqlite);

    const providerColumns = sqlite.pragma("table_info(managed_providers)") as Array<{ name: string }>;
    expect(providerColumns.some((column) => column.name === "model_catalog_url")).toBe(true);

    const modelColumns = sqlite.pragma("table_info(managed_models)") as Array<{ name: string }>;
    expect(modelColumns.some((column) => column.name === "endpoint_id")).toBe(false);

    const observationColumns = sqlite.pragma(
      "table_info(managed_account_endpoint_models)"
    ) as Array<{ name: string }>;
    expect(observationColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "account_id",
        "endpoint_id",
        "managed_model_id",
        "runtime_status",
        "status_cooldown_until",
        "last_success_at",
        "last_error_at"
      ])
    );

    const observationIndexes = sqlite.pragma(
      "index_list(managed_account_endpoint_models)"
    ) as Array<{ unique: number }>;
    expect(observationIndexes.some((index) => index.unique === 1)).toBe(true);

    const syncColumns = sqlite.pragma("table_info(model_sync_runs)") as Array<{ name: string }>;
    expect(syncColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["account_id", "catalog_url"])
    );

    sqlite.close();
  });

  it("migrates historical protocol bundles to separate explicit wire protocols", () => {
    const sqlite = new Database(":memory:");
    createLegacyProviderTables(sqlite);
    sqlite.exec(`
      INSERT INTO managed_providers (
        id,
        provider_key,
        display_name,
        base_url,
        created_at,
        updated_at
      ) VALUES (
        1,
        'relay',
        'Relay',
        'https://relay.example.com/v1',
        '2026-08-23T00:00:00.000Z',
        '2026-08-23T00:00:00.000Z'
      );

      INSERT INTO managed_provider_endpoints (
        provider_id,
        endpoint_key,
        protocol,
        base_url,
        custom_headers_json,
        supports_tools,
        created_at,
        updated_at
      ) VALUES
        (
          1,
          'openai',
          'openai',
          'https://relay.example.com/v1/',
          '{"x-region":"us","x-vendor":"relay"}',
          1,
          '2026-08-23T00:00:00.000Z',
          '2026-08-23T00:00:00.000Z'
        ),
        (
          1,
          'anthropic',
          'anthropic',
          'HTTPS://relay.example.com/v1',
          '{"x-vendor":"relay","x-region":"us"}',
          1,
          '2026-08-23T00:00:00.000Z',
          '2026-08-23T00:00:00.000Z'
        );
    `);

    runMigrations(sqlite);

    const rows = sqlite.prepare(`
      SELECT protocol
      FROM managed_provider_endpoints
      ORDER BY protocol
    `).all() as Array<{ protocol: string }>;
    expect(rows).toEqual([
      { protocol: "anthropic-messages" },
      { protocol: "openai-responses" }
    ]);
    expect((sqlite.pragma("table_info(managed_provider_endpoints)") as Array<{ name: string }>)
      .some((column) => column.name === "protocol_bundle_key")).toBe(false);
    sqlite.close();
  });

  it("rejects duplicate historical protocols without silently deleting an Endpoint", () => {
    const sqlite = new Database(":memory:");
    createLegacyProviderTables(sqlite);
    sqlite.exec(`
      INSERT INTO managed_providers (
        id,
        provider_key,
        display_name,
        base_url,
        created_at,
        updated_at
      ) VALUES (
        1,
        'duplicate',
        'Duplicate',
        'https://duplicate.example.com/v1',
        '2026-08-23T00:00:00.000Z',
        '2026-08-23T00:00:00.000Z'
      );

      INSERT INTO managed_provider_endpoints (
        provider_id,
        endpoint_key,
        protocol,
        base_url,
        created_at,
        updated_at
      ) VALUES
        (
          1,
          'default',
          'openai',
          'https://duplicate.example.com/v1',
          '2026-08-23T00:00:00.000Z',
          '2026-08-23T00:00:00.000Z'
        ),
        (
          1,
          'alt',
          'openai',
          'https://duplicate.example.com/alt',
          '2026-08-23T00:00:00.000Z',
          '2026-08-23T00:00:00.000Z'
        );
    `);

    expect(() => runMigrations(sqlite)).toThrow(/UNIQUE constraint failed/);
    expect(sqlite.prepare("SELECT endpoint_key, protocol FROM managed_provider_endpoints ORDER BY id").all())
      .toEqual([
        { endpoint_key: "default", protocol: "openai" },
        { endpoint_key: "alt", protocol: "openai" }
      ]);
    const indexes = sqlite.prepare(`
      SELECT name
      FROM pragma_index_list('managed_provider_endpoints')
      WHERE name = 'managed_provider_endpoints_provider_protocol_unique'
    `).all();
    expect(indexes).toHaveLength(0);
    sqlite.close();
  });

  it("drops historical account endpoint bindings", () => {
    const sqlite = new Database(":memory:");
    createLegacyProviderTables(sqlite);
    sqlite.exec(`
      INSERT INTO managed_providers (
        id,
        provider_key,
        display_name,
        base_url,
        created_at,
        updated_at
      ) VALUES (
        1,
        'relay',
        'Relay',
        'https://relay.example.com/v1',
        '2026-08-23T00:00:00.000Z',
        '2026-08-23T00:00:00.000Z'
      );

      INSERT INTO managed_provider_endpoints (
        id,
        provider_id,
        endpoint_key,
        protocol,
        base_url,
        created_at,
        updated_at
      ) VALUES (
        7,
        1,
        'anthropic',
        'anthropic',
        'https://relay.example.com/anthropic',
        '2026-08-23T00:00:00.000Z',
        '2026-08-23T00:00:00.000Z'
      );

      CREATE TABLE managed_provider_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id INTEGER NOT NULL,
        account_key TEXT NOT NULL DEFAULT 'default',
        endpoint_id INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        runtime_status TEXT NOT NULL DEFAULT 'normal',
        status_source TEXT NOT NULL DEFAULT 'system',
        recent_error_count INTEGER NOT NULL DEFAULT 0,
        api_key_encrypted TEXT NOT NULL,
        key_hint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider_id, account_key)
      );

      INSERT INTO managed_provider_credentials (
        id,
        provider_id,
        account_key,
        endpoint_id,
        api_key_encrypted,
        key_hint,
        created_at,
        updated_at
      ) VALUES (
        9,
        1,
        'default',
        7,
        'encrypted',
        '...ted',
        '2026-08-23T00:00:00.000Z',
        '2026-08-23T00:00:00.000Z'
      );
    `);

    runMigrations(sqlite);

    const columns = sqlite.pragma("table_info(managed_provider_credentials)") as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "endpoint_id")).toBe(false);
    const row = sqlite.prepare(`
      SELECT account_key AS accountKey, key_hint AS keyHint
      FROM managed_provider_credentials
    `).get() as { accountKey: string; keyHint: string };
    expect(row).toEqual({ accountKey: "default", keyHint: "...ted" });
    sqlite.close();
  });

  it("clears ambiguous legacy OpenAI model errors after moving endpoint-scoped observations", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    sqlite.exec(`
      ALTER TABLE managed_models ADD COLUMN endpoint_id INTEGER;

      INSERT INTO managed_providers (
        id,
        provider_key,
        display_name,
        base_url,
        created_at,
        updated_at
      ) VALUES (
        1,
        'relay',
        'Relay',
        'https://relay.example.com/v1',
        '2026-08-29T00:00:00.000Z',
        '2026-08-29T00:00:00.000Z'
      );

      INSERT INTO managed_provider_endpoints (
        id,
        provider_id,
        endpoint_key,
        protocol,
        base_url,
        created_at,
        updated_at
      ) VALUES (
        7,
        1,
        'openai',
        'openai',
        'https://relay.example.com/v1',
        '2026-08-29T00:00:00.000Z',
        '2026-08-29T00:00:00.000Z'
      );

      INSERT INTO managed_provider_credentials (
        id,
        provider_id,
        account_key,
        api_key_encrypted,
        created_at,
        updated_at
      ) VALUES (
        9,
        1,
        'default',
        'encrypted',
        '2026-08-29T00:00:00.000Z',
        '2026-08-29T00:00:00.000Z'
      );

      INSERT INTO managed_models (
        id,
        provider_id,
        endpoint_id,
        model_key,
        provider_model_id,
        model_name,
        runtime_status,
        status_reason,
        status_message,
        status_source,
        status_updated_at,
        status_cooldown_until,
        cooldown_strike,
        recent_error_count,
        last_error_at,
        last_error_code,
        last_error_message,
        discovered_at,
        updated_at
      ) VALUES (
        11,
        1,
        7,
        'relay/model-a',
        'model-a',
        'model-a',
        'cooling_down',
        'model_unavailable',
        'Model is unavailable',
        'system',
        '2026-08-29T00:01:00.000Z',
        '2026-08-29T00:31:00.000Z',
        2,
        3,
        '2026-08-29T00:01:00.000Z',
        'provider_invalid_model',
        'Model is unavailable',
        '2026-08-29T00:00:00.000Z',
        '2026-08-29T00:01:00.000Z'
      );

      INSERT INTO managed_account_models (
        account_id,
        managed_model_id,
        discovered_at,
        last_seen_at
      ) VALUES (
        9,
        11,
        '2026-08-29T00:00:00.000Z',
        '2026-08-29T00:01:00.000Z'
      );
    `);

    runMigrations(sqlite);

    const modelColumns = sqlite.pragma("table_info(managed_models)") as Array<{ name: string }>;
    expect(modelColumns.some((column) => column.name === "endpoint_id")).toBe(false);
    const observation = sqlite.prepare(`
      SELECT
        account_id AS accountId,
        endpoint_id AS endpointId,
        managed_model_id AS managedModelId,
        runtime_status AS runtimeStatus,
        status_reason AS statusReason,
        cooldown_strike AS cooldownStrike,
        recent_error_count AS recentErrorCount,
        last_error_code AS lastErrorCode
      FROM managed_account_endpoint_models
    `).get();
    expect(observation).toEqual({
      accountId: 9,
      endpointId: 7,
      managedModelId: 11,
      runtimeStatus: "unknown",
      statusReason: null,
      cooldownStrike: 0,
      recentErrorCount: 0,
      lastErrorCode: null
    });
    sqlite.close();
  });

  it("merges historical endpoint-prefixed provider models without losing account state", () => {
    const sqlite = new Database(":memory:");
    runMigrations(sqlite);
    sqlite.exec(`
      INSERT INTO managed_providers (
        id, provider_key, display_name, base_url, created_at, updated_at
      ) VALUES (
        1, 'relay', 'Relay', 'https://relay.example.com/v1',
        '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z'
      );

      INSERT INTO managed_provider_endpoints (
        id, provider_id, endpoint_key, protocol, base_url, created_at, updated_at
      ) VALUES
        (
          7, 1, 'openai', 'openai', 'https://relay.example.com/v1',
          '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z'
        ),
        (
          8, 1, 'anthropic', 'anthropic', 'https://relay.example.com/v1',
          '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z'
        );

      INSERT INTO managed_provider_credentials (
        id, provider_id, account_key, api_key_encrypted, created_at, updated_at
      ) VALUES (
        9, 1, 'default', 'encrypted',
        '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z'
      );

      INSERT INTO managed_models (
        id, provider_id, model_key, provider_model_id, model_name,
        enabled, supports_streaming, supports_tools,
        discovered_at, updated_at
      ) VALUES
        (
          11, 1, 'relay/openai/openai/claude-opus-5', 'openai:openai/claude-opus-5',
          'claude-opus-5', 1, 1, 0,
          '2026-08-30T00:00:00.000Z', '2026-08-30T00:01:00.000Z'
        ),
        (
          12, 1, 'relay/openai/claude-opus-5', 'openai:claude-opus-5',
          'claude-opus-5', 1, 1, 1,
          '2026-08-30T00:00:00.000Z', '2026-08-30T00:02:00.000Z'
        ),
        (
          13, 1, 'relay/anthropic/openai/claude-opus-5',
          'anthropic:openai/claude-opus-5',
          'claude-opus-5', 1, 1, 0,
          '2026-08-30T00:00:00.000Z', '2026-08-30T00:03:00.000Z'
        );

      INSERT INTO managed_account_models (
        account_id, managed_model_id, enabled, runtime_status,
        status_reason, status_updated_at, recent_error_count,
        discovered_at, last_seen_at
      ) VALUES
        (
          9, 11, 1, 'normal', NULL, NULL, 0,
          '2026-08-30T00:00:00.000Z', '2026-08-30T00:01:00.000Z'
        ),
        (
          9, 12, 0, 'cooling_down', 'model_unavailable',
          '2026-08-30T00:02:00.000Z', 3,
          '2026-08-30T00:00:00.000Z', '2026-08-30T00:02:00.000Z'
        ),
        (
          9, 13, 1, 'normal', NULL, NULL, 0,
          '2026-08-30T00:00:00.000Z', '2026-08-30T00:03:00.000Z'
        );

      INSERT INTO managed_account_endpoint_models (
        account_id, endpoint_id, managed_model_id, runtime_status,
        last_success_at, created_at, updated_at
      ) VALUES
        (
          9, 7, 11, 'normal', '2026-08-30T00:01:00.000Z',
          '2026-08-30T00:01:00.000Z', '2026-08-30T00:01:00.000Z'
        ),
        (
          9, 8, 12, 'normal', '2026-08-30T00:02:00.000Z',
          '2026-08-30T00:02:00.000Z', '2026-08-30T00:02:00.000Z'
        ),
        (
          9, 8, 13, 'normal', '2026-08-30T00:03:00.000Z',
          '2026-08-30T00:03:00.000Z', '2026-08-30T00:03:00.000Z'
        );
    `);

    runMigrations(sqlite);
    runMigrations(sqlite);

    const models = sqlite.prepare(`
      SELECT id, model_key AS modelKey, provider_model_id AS providerModelId,
             supports_tools AS supportsTools
      FROM managed_models
      WHERE provider_id = 1
    `).all();
    expect(models).toEqual([{
      id: 11,
      modelKey: "relay/claude-opus-5",
      providerModelId: "claude-opus-5",
      supportsTools: 1
    }]);

    const accountModels = sqlite.prepare(`
      SELECT managed_model_id AS managedModelId, enabled, runtime_status AS runtimeStatus,
             status_reason AS statusReason, recent_error_count AS recentErrorCount
      FROM managed_account_models
      WHERE account_id = 9
    `).all();
    expect(accountModels).toEqual([{
      managedModelId: 11,
      enabled: 0,
      runtimeStatus: "cooling_down",
      statusReason: "model_unavailable",
      recentErrorCount: 3
    }]);

    const observations = sqlite.prepare(`
      SELECT endpoint_id AS endpointId, managed_model_id AS managedModelId, last_success_at AS lastSuccessAt
      FROM managed_account_endpoint_models
      WHERE account_id = 9
      ORDER BY endpoint_id
    `).all();
    expect(observations).toEqual([
      { endpointId: 7, managedModelId: 11, lastSuccessAt: null },
      { endpointId: 8, managedModelId: 11, lastSuccessAt: "2026-08-30T00:03:00.000Z" }
    ]);

    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    sqlite.close();
  });
});
