import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function legacyDatabase() {
  const database = new Database(":memory:");
  databases.push(database);
  runMigrations(database);
  database.exec(`
    INSERT INTO managed_providers
      (id, provider_key, display_name, base_url, created_at, updated_at)
    VALUES (1, 'relay', 'Relay', 'https://example.com/v1', '2026-09-05', '2026-09-05');
    INSERT INTO managed_provider_endpoints
      (id, provider_id, endpoint_key, protocol, base_url, runtime_status,
       status_reason, cooldown_strike, recent_error_count, created_at, updated_at)
    VALUES (1, 1, 'openai', 'openai', 'https://example.com/v1', 'cooling_down',
            'model_unavailable', 2, 3, '2026-09-05', '2026-09-05'),
           (2, 1, 'anthropic', 'anthropic', 'https://example.com/v1', 'normal',
            NULL, 0, 0, '2026-09-05', '2026-09-05');
    INSERT INTO managed_provider_credentials
      (id, provider_id, account_key, api_key_encrypted, created_at, updated_at)
    VALUES (1, 1, 'main', 'encrypted', '2026-09-05', '2026-09-05');
    INSERT INTO managed_models
      (id, provider_id, model_key, provider_model_id, model_name, discovered_at, updated_at)
    VALUES (1, 1, 'relay/model', 'model', 'model', '2026-09-05', '2026-09-05');
    INSERT INTO managed_account_models
      (account_id, managed_model_id, enabled, discovered_at, last_seen_at)
    VALUES (1, 1, 0, '2026-09-05', '2026-09-05');
    INSERT INTO managed_account_endpoint_models
      (account_id, endpoint_id, managed_model_id, runtime_status, last_success_at,
       last_error_code, cooldown_strike, recent_error_count, created_at, updated_at)
    VALUES (1, 1, 1, 'cooling_down', '2026-09-05', 'provider_invalid_model', 2, 3,
            '2026-09-05', '2026-09-05'),
           (1, 2, 1, 'normal', '2026-09-05', NULL, 0, 0, '2026-09-05', '2026-09-05');
  `);
  return database;
}

describe("wire protocol migration", () => {
  it("renames Endpoint identities without synthesizing Chat Completions or copying ambiguous observations", () => {
    const database = legacyDatabase();
    const accounts = database.prepare("SELECT * FROM managed_provider_credentials").all();
    const visibility = database.prepare("SELECT * FROM managed_account_models").all();
    runMigrations(database);
    expect(database.prepare("SELECT id, endpoint_key, protocol FROM managed_provider_endpoints ORDER BY id").all())
      .toEqual([
        { id: 1, endpoint_key: "openai-responses", protocol: "openai-responses" },
        { id: 2, endpoint_key: "anthropic-messages", protocol: "anthropic-messages" }
      ]);
    expect(database.prepare(`SELECT runtime_status, last_success_at, last_error_code,
      cooldown_strike, recent_error_count FROM managed_account_endpoint_models WHERE endpoint_id = 1`).get())
      .toEqual({ runtime_status: "unknown", last_success_at: null, last_error_code: null,
        cooldown_strike: 0, recent_error_count: 0 });
    expect(database.prepare("SELECT runtime_status FROM managed_provider_endpoints WHERE id = 1").get())
      .toEqual({ runtime_status: "unknown" });
    expect(database.prepare("SELECT last_success_at FROM managed_account_endpoint_models WHERE endpoint_id = 2").get())
      .toEqual({ last_success_at: "2026-09-05" });
    expect(database.prepare("SELECT * FROM managed_provider_credentials").all()).toEqual(accounts);
    expect(database.prepare("SELECT * FROM managed_account_models").all()).toEqual(visibility);
    database.exec("UPDATE managed_account_endpoint_models SET runtime_status = 'normal', last_success_at = '2026-09-06' WHERE endpoint_id = 1");
    runMigrations(database);
    expect(database.prepare("SELECT last_success_at FROM managed_account_endpoint_models WHERE endpoint_id = 1").get())
      .toEqual({ last_success_at: "2026-09-06" });
    expect(database.pragma("foreign_key_check")).toEqual([]);
  });

  it("rolls back protocol changes and observations on conflicting protocol identities", () => {
    const database = legacyDatabase();
    database.exec(`INSERT INTO managed_provider_endpoints
      (provider_id, endpoint_key, protocol, base_url, created_at, updated_at)
      VALUES (1, 'openai-responses', 'openai-responses', 'https://other.example/v1', '2026-09-05', '2026-09-05')`);
    expect(() => runMigrations(database)).toThrow();
    expect(database.prepare("SELECT protocol FROM managed_provider_endpoints WHERE id = 1").get())
      .toEqual({ protocol: "openai" });
    expect(database.prepare("SELECT runtime_status FROM managed_account_endpoint_models WHERE endpoint_id = 1").get())
      .toEqual({ runtime_status: "cooling_down" });
  });

  it("renames swapped legacy keys without transient uniqueness collisions", () => {
    const database = legacyDatabase();
    database.exec(`UPDATE managed_provider_endpoints SET endpoint_key =
      CASE protocol WHEN 'openai' THEN 'anthropic-messages' ELSE 'openai-responses' END`);
    runMigrations(database);
    expect(database.prepare("SELECT endpoint_key, protocol FROM managed_provider_endpoints ORDER BY id").all())
      .toEqual([
        { endpoint_key: "openai-responses", protocol: "openai-responses" },
        { endpoint_key: "anthropic-messages", protocol: "anthropic-messages" }
      ]);
  });

  it("creates a sparse Account-Endpoint relation with unique identity and cascading deletion", () => {
    const database = legacyDatabase();
    runMigrations(database);
    expect(database.prepare("SELECT count(*) AS count FROM managed_account_endpoints").get())
      .toEqual({ count: 0 });
    const insert = database.prepare(`INSERT INTO managed_account_endpoints
      (account_id, endpoint_id, created_at, updated_at) VALUES (?, ?, '2026-09-05', '2026-09-05')`);
    insert.run(1, 1);
    expect(() => insert.run(1, 1)).toThrow(/UNIQUE/);
    expect(() => insert.run(999, 1)).toThrow(/FOREIGN KEY/);
    expect(database.prepare("SELECT enabled, runtime_status, last_success_at FROM managed_account_endpoints").get())
      .toEqual({ enabled: 1, runtime_status: "unknown", last_success_at: null });
    database.exec("DELETE FROM managed_provider_endpoints WHERE id = 1");
    expect(database.prepare("SELECT count(*) AS count FROM managed_account_endpoints").get())
      .toEqual({ count: 0 });
  });
});
