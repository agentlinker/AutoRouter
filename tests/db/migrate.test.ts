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
  it("marks historical openai and anthropic endpoints with matching config as an all bundle", () => {
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
      SELECT protocol, protocol_bundle_key AS protocolBundleKey
      FROM managed_provider_endpoints
      ORDER BY protocol
    `).all() as Array<{ protocol: string; protocolBundleKey: string | null }>;
    expect(rows).toEqual([
      { protocol: "anthropic", protocolBundleKey: "all" },
      { protocol: "openai", protocolBundleKey: "all" }
    ]);
    sqlite.close();
  });

  it("keeps duplicate historical protocols readable instead of creating a failing unique index", () => {
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

    expect(() => runMigrations(sqlite)).not.toThrow();
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
});
