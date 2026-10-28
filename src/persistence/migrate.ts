import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lockExecution } from "./execution-lock.ts";
import { embeddedMigrations, type LedgerMigration } from "./migrations/embedded.ts";

export type { LedgerMigration } from "./migrations/embedded.ts";
export { embeddedMigrations } from "./migrations/embedded.ts";

export const latestLedgerVersion = embeddedMigrations.length;

export function migrationHash(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function ledgerVersion(database: Database): number {
  if (!hasTable(database, "__drizzle_migrations")) return 0;
  const row = database
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM __drizzle_migrations")
    .get();
  return row?.count ?? 0;
}

export function backupLedger(database: Database, path: string): string {
  const backupPath = `${path}.backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
  database.exec("PRAGMA wal_checkpoint(FULL)");
  const statement = database.prepare("VACUUM INTO ?");
  try {
    statement.run(backupPath);
  } finally {
    statement.finalize();
  }
  return backupPath;
}

export function migrateLedger(
  database: Database,
  path: string,
  migrations: readonly LedgerMigration[] = embeddedMigrations,
): { version: number; backupPath?: string } {
  const latest = migrations.length;
  const applied = ledgerVersion(database);
  if (applied > latest) {
    throw new Error(
      `Ledger schema version ${applied} is newer than this Interlock supports (version ${latest}); refusing to downgrade or open it. The ledger was left unchanged.`,
    );
  }
  const adopting = applied === 0 && hasTable(database, "runs") && migrations.length > 0;
  const startIndex = adopting ? 1 : applied;
  const pending = migrations.slice(startIndex);
  if (!adopting && pending.length === 0) return { version: applied };
  const hadLedger = path !== ":memory:" && (applied > 0 || adopting) && existsSync(path);
  let unlock: (() => void) | undefined;
  let backupPath: string | undefined;
  if (path !== ":memory:") {
    unlock = lockExecution(path);
  }
  try {
    if (hadLedger && path !== ":memory:") backupPath = backupLedger(database, path);
    database.exec("PRAGMA foreign_keys=OFF");
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(
          `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)`,
        );
        const first = migrations[0];
        if (adopting && first) recordMigration(database, first);
        for (const migration of pending) {
          for (const statement of migration.sql.split("--> statement-breakpoint")) {
            const trimmed = statement.trim();
            if (trimmed) database.exec(trimmed);
          }
          recordMigration(database, migration);
        }
        const violations = database.query("PRAGMA foreign_key_check").all();
        if (violations.length > 0)
          throw new Error(`foreign_key_check failed with ${violations.length} violation(s)`);
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    } finally {
      database.exec("PRAGMA foreign_keys=ON");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const suffix = backupPath ? ` Backup: ${backupPath}` : "";
    throw new Error(
      `Ledger migration failed and the ledger was left unchanged: ${detail}.${suffix}`,
      {
        cause: error,
      },
    );
  } finally {
    unlock?.();
  }
  return backupPath ? { version: latest, backupPath } : { version: latest };
}

function hasTable(database: Database, name: string): boolean {
  const row = database
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(name);
  return Boolean(row);
}

function recordMigration(database: Database, migration: LedgerMigration): void {
  const statement = database.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  );
  try {
    statement.run(migrationHash(migration.sql), Date.now());
  } finally {
    statement.finalize();
  }
}
