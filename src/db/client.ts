import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { expandHome } from "../utils/path.js";
import { runMigrations } from "./migrate.js";
import { schema } from "./schema.js";

export interface DatabaseClient {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
}

export function createDatabaseClient(databasePath: string): DatabaseClient {
  const resolvedPath = expandHome(databasePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });

  const sqlite = new Database(resolvedPath);
  runMigrations(sqlite);

  return {
    sqlite,
    db: drizzle(sqlite, { schema })
  };
}
