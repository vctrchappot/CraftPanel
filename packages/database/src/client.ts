import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import * as schema from "./schema";

export type Database = SqliteRemoteDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  raw: DatabaseSync;
  close(): void;
}

type SqlValue = null | number | bigint | string | Uint8Array;

/**
 * Open the SQLite database using Node's built-in `node:sqlite` driver (no
 * native add-on to compile) and expose it to Drizzle via the proxy driver.
 */
export function openDatabase(file: string): DatabaseHandle {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");

  const db = drizzle(
    async (sql, params, method) => {
      const stmt = raw.prepare(sql);
      const args = params as SqlValue[];
      if (method === "run") {
        stmt.run(...args);
        return { rows: [] };
      }
      stmt.setReturnArrays(true);
      if (method === "get") {
        const row = stmt.get(...args) as unknown as unknown[] | undefined;
        return { rows: (row ?? undefined) as unknown as unknown[] };
      }
      const rows = stmt.all(...args) as unknown as unknown[][];
      return { rows };
    },
    async (queries) => {
      // Batch is executed in a single transaction.
      raw.exec("BEGIN");
      try {
        const results = queries.map((q) => {
          const stmt = raw.prepare(q.sql);
          if (q.method === "run") {
            stmt.run(...(q.params as SqlValue[]));
            return { rows: [] };
          }
          stmt.setReturnArrays(true);
          return { rows: stmt.all(...(q.params as SqlValue[])) as unknown as unknown[] };
        });
        raw.exec("COMMIT");
        return results;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    { schema },
  );

  return { db, raw, close: () => raw.close() };
}

export function defaultMigrationsFolder(): string {
  const env = process.env.CRAFTPANEL_MIGRATIONS_DIR;
  if (env) return env;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Source layout: packages/database/src -> packages/database/drizzle
  return path.resolve(here, "../drizzle");
}

export async function runMigrations(handle: DatabaseHandle, migrationsFolder = defaultMigrationsFolder()): Promise<void> {
  await migrate(
    handle.db,
    async (queries) => {
      handle.raw.exec("BEGIN");
      try {
        for (const q of queries) handle.raw.exec(q);
        handle.raw.exec("COMMIT");
      } catch (e) {
        handle.raw.exec("ROLLBACK");
        throw e;
      }
    },
    { migrationsFolder },
  );
}
