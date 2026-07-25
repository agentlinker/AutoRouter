import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";

import { appSettingsTable, type schema } from "../db/schema.js";
import {
  DEFAULT_RUNTIME_STATUS_SETTINGS,
  RUNTIME_STATUS_SETTINGS_KEY,
  normalizeRuntimeStatusSettings,
  type RuntimeStatusSettings
} from "../runtime/runtimeStatus.js";

type Db = BetterSQLite3Database<typeof schema>;

function nowIso(): string {
  return new Date().toISOString();
}

export class AppSettingsRepository {
  public constructor(private readonly db: Db) {}

  public getJson<T>(key: string): T | null {
    const row = this.db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key)).get();
    if (!row) {
      return null;
    }
    try {
      return JSON.parse(row.valueJson) as T;
    } catch {
      return null;
    }
  }

  public setJson(key: string, value: unknown): void {
    const now = nowIso();
    const existing = this.db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key)).get();
    const valueJson = JSON.stringify(value);
    if (existing) {
      this.db
        .update(appSettingsTable)
        .set({ valueJson, updatedAt: now })
        .where(eq(appSettingsTable.key, key))
        .run();
      return;
    }
    this.db
      .insert(appSettingsTable)
      .values({ key, valueJson, updatedAt: now })
      .run();
  }

  public getRuntimeStatusSettings(): RuntimeStatusSettings {
    const stored = this.getJson<Partial<RuntimeStatusSettings>>(RUNTIME_STATUS_SETTINGS_KEY);
    return normalizeRuntimeStatusSettings(stored ?? DEFAULT_RUNTIME_STATUS_SETTINGS);
  }

  public setRuntimeStatusSettings(
    input: Partial<RuntimeStatusSettings>
  ): RuntimeStatusSettings {
    const next = normalizeRuntimeStatusSettings({
      ...this.getRuntimeStatusSettings(),
      ...input
    });
    this.setJson(RUNTIME_STATUS_SETTINGS_KEY, next);
    return next;
  }
}
