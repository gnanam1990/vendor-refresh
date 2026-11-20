import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  let current = row.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.exec("BEGIN");
      try {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
          m.version,
          new Date().toISOString()
        );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }
}

/** Run fn inside a transaction; rolls back on throw. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function now(): string {
  return new Date().toISOString();
}
