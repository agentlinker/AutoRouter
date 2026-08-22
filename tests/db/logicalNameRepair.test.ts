import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";

/**
 * 回归用例：旧归一化规则在字母与数字之间插了分隔符，历史库里留下 `deepseek-v-4-pro`
 * 这类上游并不存在的名字。这些名字无法从自身反推，必须以 provider_model_id 重算并迁移。
 */
describe("legacy logical name repair", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    runMigrations(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  const now = "2026-01-01T00:00:00.000Z";

  function insertProvider(providerKey: string): number {
    return Number(
      sqlite
        .prepare(
          `INSERT INTO managed_providers (provider_key, display_name, base_url, created_at, updated_at)
           VALUES (?, ?, 'https://example.test', ?, ?)`
        )
        .run(providerKey, providerKey, now, now).lastInsertRowid
    );
  }

  function insertEndpoint(providerId: number, endpointKey: string, protocol: string): number {
    return Number(
      sqlite
        .prepare(
          `INSERT INTO managed_provider_endpoints
             (provider_id, endpoint_key, protocol, base_url, created_at, updated_at)
           VALUES (?, ?, ?, 'https://example.test', ?, ?)`
        )
        .run(providerId, endpointKey, protocol, now, now).lastInsertRowid
    );
  }

  function insertLogical(
    logicalName: string,
    metadataSource: string,
    extra: { contextWindow?: number; aliases?: string[] } = {}
  ): number {
    return Number(
      sqlite
        .prepare(
          `INSERT INTO logical_models
             (logical_name, display_name, aliases_json, context_window, supports_streaming,
              supports_tools, supports_json_mode, metadata_source, metadata_confidence,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 1, 0, ?, 'low', ?, ?)`
        )
        .run(
          logicalName,
          logicalName,
          extra.aliases ? JSON.stringify(extra.aliases) : null,
          extra.contextWindow ?? null,
          metadataSource,
          now,
          now
        ).lastInsertRowid
    );
  }

  function insertModel(input: {
    providerId: number;
    endpointId: number | null;
    providerModelId: string;
    modelName: string;
    logicalModelId: number | null;
  }): number {
    return Number(
      sqlite
        .prepare(
          `INSERT INTO managed_models
             (provider_id, endpoint_id, model_key, provider_model_id, model_name,
              logical_model_id, discovered_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.providerId,
          input.endpointId,
          `${input.providerId}/${input.providerModelId}`,
          input.providerModelId,
          input.modelName,
          input.logicalModelId,
          now,
          now
        ).lastInsertRowid
    );
  }

  function logicalNames(): string[] {
    return (
      sqlite.prepare(`SELECT logical_name FROM logical_models ORDER BY logical_name`).all() as Array<{
        logical_name: string;
      }>
    ).map((row) => row.logical_name);
  }

  function aliasesOf(logicalName: string): string[] {
    const row = sqlite
      .prepare(`SELECT aliases_json FROM logical_models WHERE logical_name = ?`)
      .get(logicalName) as { aliases_json: string | null } | undefined;
    return row?.aliases_json ? (JSON.parse(row.aliases_json) as string[]) : [];
  }

  it("renames a legacy logical name when the target name is free", () => {
    const providerId = insertProvider("relay-a");
    const endpointId = insertEndpoint(providerId, "default", "openai");
    const logicalId = insertLogical("deepseek-v-4-pro", "provider_derived");
    insertModel({
      providerId,
      endpointId,
      providerModelId: "deepseek-v4-pro",
      modelName: "deepseek-v-4-pro",
      logicalModelId: logicalId
    });

    runMigrations(sqlite);

    expect(logicalNames()).toContain("deepseek-v4-pro");
    expect(logicalNames()).not.toContain("deepseek-v-4-pro");
    // 旧名保留为 alias，老客户端继续可用。
    expect(aliasesOf("deepseek-v4-pro")).toContain("deepseek-v-4-pro");
  });

  it("keeps model_name aligned with the repaired logical name", () => {
    const providerId = insertProvider("relay-b");
    const endpointId = insertEndpoint(providerId, "default", "openai");
    const logicalId = insertLogical("deepseek-v-4-pro", "provider_derived");
    const modelId = insertModel({
      providerId,
      endpointId,
      providerModelId: "deepseek-ai/deepseek-v4-pro",
      modelName: "deepseek-v-4-pro",
      logicalModelId: logicalId
    });

    runMigrations(sqlite);

    const row = sqlite
      .prepare(`SELECT model_name FROM managed_models WHERE id = ?`)
      .get(modelId) as { model_name: string };
    expect(row.model_name).toBe("deepseek-v4-pro");
  });

  it("merges into the richer row when the target name is taken", () => {
    const providerId = insertProvider("relay-c");
    const endpointId = insertEndpoint(providerId, "default", "openai");

    // 目标名已存在且元数据更好（openrouter + context_window）。
    const richId = insertLogical("deepseek-v4-pro", "openrouter", {
      contextWindow: 1_048_576,
      aliases: ["deepseek-v4-pro"]
    });
    const legacyId = insertLogical("deepseek-v-4-pro", "provider_derived", {
      aliases: ["deepseek-v-4-pro", "deepseek/deepseek-v4-pro"]
    });

    const legacyModelId = insertModel({
      providerId,
      endpointId,
      providerModelId: "deepseek-v4-pro",
      modelName: "deepseek-v-4-pro",
      logicalModelId: legacyId
    });

    runMigrations(sqlite);

    // 合并成一行，元数据更完整的一方胜出。
    expect(logicalNames().filter((name) => name.includes("deepseek"))).toEqual([
      "deepseek-v4-pro"
    ]);
    const survivor = sqlite
      .prepare(
        `SELECT id, metadata_source, context_window FROM logical_models WHERE logical_name = ?`
      )
      .get("deepseek-v4-pro") as {
        id: number;
        metadata_source: string;
        context_window: number | null;
      };
    expect(survivor.id).toBe(richId);
    expect(survivor.metadata_source).toBe("openrouter");
    expect(survivor.context_window).toBe(1_048_576);

    // managed_models 重绑到存活行，两边 alias 并集保留。
    const rebound = sqlite
      .prepare(`SELECT logical_model_id FROM managed_models WHERE id = ?`)
      .get(legacyModelId) as { logical_model_id: number };
    expect(rebound.logical_model_id).toBe(richId);
    expect(aliasesOf("deepseek-v4-pro")).toEqual(
      expect.arrayContaining(["deepseek-v4-pro", "deepseek-v-4-pro", "deepseek/deepseek-v4-pro"])
    );
  });

  it("strips synthetic endpoint prefixes from aliases", () => {
    const providerId = insertProvider("multi-endpoint");
    const openaiEndpoint = insertEndpoint(providerId, "openai", "openai");
    const anthropicEndpoint = insertEndpoint(providerId, "anthropic", "anthropic");
    const logicalId = insertLogical("claude-opus-4.7", "provider_derived", {
      // 早期 backfill 把合成 id 塞进了 aliases。
      aliases: ["claude-opus-4.7", "openai:claude-opus-4.7", "anthropic:claude-opus-4.7"]
    });

    insertModel({
      providerId,
      endpointId: openaiEndpoint,
      providerModelId: "openai:claude-opus-4.7",
      modelName: "claude-opus-4.7",
      logicalModelId: logicalId
    });
    insertModel({
      providerId,
      endpointId: anthropicEndpoint,
      providerModelId: "anthropic:claude-opus-4.7",
      modelName: "claude-opus-4.7",
      logicalModelId: logicalId
    });

    runMigrations(sqlite);

    const aliases = aliasesOf("claude-opus-4.7");
    expect(aliases).toContain("claude-opus-4.7");
    expect(aliases.filter((alias) => /^(openai|anthropic):/.test(alias))).toEqual([]);
  });

  it("is idempotent across repeated runs", () => {
    const providerId = insertProvider("relay-d");
    const endpointId = insertEndpoint(providerId, "default", "openai");
    const logicalId = insertLogical("deepseek-v-4-pro", "provider_derived");
    insertModel({
      providerId,
      endpointId,
      providerModelId: "deepseek-v4-pro",
      modelName: "deepseek-v-4-pro",
      logicalModelId: logicalId
    });

    runMigrations(sqlite);
    const afterFirst = logicalNames();
    const aliasesAfterFirst = aliasesOf("deepseek-v4-pro");

    runMigrations(sqlite);
    runMigrations(sqlite);

    expect(logicalNames()).toEqual(afterFirst);
    expect(aliasesOf("deepseek-v4-pro")).toEqual(aliasesAfterFirst);
  });

  it("leaves models without an endpoint binding untouched", () => {
    const providerId = insertProvider("legacy-null-endpoint");
    const logicalId = insertLogical("deepseek-v-4-pro", "provider_derived");
    insertModel({
      providerId,
      endpointId: null,
      providerModelId: "deepseek-v4-pro",
      modelName: "deepseek-v-4-pro",
      logicalModelId: logicalId
    });

    runMigrations(sqlite);

    expect(logicalNames()).toContain("deepseek-v4-pro");
    expect(aliasesOf("deepseek-v4-pro")).toContain("deepseek-v4-pro");
  });
});
