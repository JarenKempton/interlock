import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actorRefSchema,
  adapterRefSchema,
  claimRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../src/domain/identifiers.ts";
import { capabilities } from "../src/domain/model.ts";
import { embeddedMigrations, latestLedgerVersion } from "../src/persistence/migrate.ts";
import { StateStore } from "../src/persistence/state.ts";

function directory() {
  return mkdtempSync(join(tmpdir(), "interlock-migrations-"));
}

function sampleRun(ref = "interlock-run:migration-test") {
  const now = new Date().toISOString();
  return {
    ref: runRefSchema.parse(ref),
    ticket: ticketRefSchema.parse("jira:x:W:ticket:A"),
    harness: adapterRefSchema.parse("codex"),
    workspace: { path: "/tmp/work" },
    capabilities: capabilities(),
    status: "planning" as const,
    createdAt: now,
    updatedAt: now,
  };
}

const legacySchema = `
CREATE TABLE configuration_overrides (project_path TEXT PRIMARY KEY, settings_json TEXT NOT NULL);
CREATE TABLE runs (ref TEXT PRIMARY KEY, ticket TEXT NOT NULL, harness TEXT NOT NULL, model TEXT, effort TEXT, context TEXT, workspace_json TEXT NOT NULL, capabilities_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, execution_json TEXT);
CREATE TABLE execution_configurations (run_ref TEXT PRIMARY KEY REFERENCES runs(ref), snapshot_json TEXT NOT NULL);
CREATE TABLE claims (ref TEXT PRIMARY KEY, ticket TEXT NOT NULL, human_owner TEXT NOT NULL, run_ref TEXT NOT NULL REFERENCES runs(ref), previous_state_json TEXT NOT NULL, claimed_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL, status TEXT NOT NULL, current_version TEXT, supersedes TEXT, superseded_by TEXT);
CREATE TABLE recovery_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, run_ref TEXT NOT NULL REFERENCES runs(ref), outcome TEXT NOT NULL, evidence_json TEXT NOT NULL, occurred_at TEXT NOT NULL);
CREATE TABLE transaction_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, run_ref TEXT NOT NULL REFERENCES runs(ref), state TEXT NOT NULL, receipt_json TEXT, error_text TEXT, occurred_at TEXT NOT NULL);`;

test("fresh ledger is migrated to the latest version", () => {
  const dir = directory();
  const path = join(dir, "interlock.db");
  try {
    const store = new StateStore(path);
    try {
      expect(store.ledgerVersion).toBe(latestLedgerVersion);
      const run = sampleRun();
      store.saveRun(run);
      expect(store.run(run.ref)).toEqual(run);
    } finally {
      store.close();
    }
    const check = new Database(path, { readonly: true });
    const tables = check
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);
    check.close();
    for (const table of ["runs", "claims", "configuration_overrides", "__drizzle_migrations"])
      expect(tables).toContain(table);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-migration ledger is adopted with no data loss and a backup", () => {
  const dir = directory();
  const path = join(dir, "interlock.db");
  try {
    const legacy = new Database(path, { create: true });
    legacy.exec(legacySchema);
    const now = new Date().toISOString();
    legacy
      .query(
        "INSERT INTO runs(ref,ticket,harness,workspace_json,capabilities_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run("interlock-run:legacy", "jira:x:W:ticket:A", "codex", "{}", "{}", "planning", now, now);
    legacy.close();
    const store = new StateStore(path);
    try {
      expect(store.ledgerVersion).toBe(latestLedgerVersion);
      expect(store.run(runRefSchema.parse("interlock-run:legacy")).status).toBe("planning");
      expect(store.migrationBackupPath).toBeDefined();
      expect(existsSync(store.migrationBackupPath ?? "")).toBe(true);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every committed sample ledger upgrades to the latest version", () => {
  const fixtures = readdirSync("test/fixtures/ledgers").filter((name) => name.endsWith(".db"));
  expect(fixtures.length).toBeGreaterThan(0);
  for (const fixture of fixtures) {
    const dir = directory();
    const path = join(dir, "interlock.db");
    try {
      copyFileSync(join("test/fixtures/ledgers", fixture), path);
      const store = new StateStore(path);
      try {
        expect(store.ledgerVersion).toBe(latestLedgerVersion);
        expect(store.run(runRefSchema.parse("interlock-run:sample-v1")).status).toBe("claimed");
        expect(store.claim(claimRefSchema.parse("interlock-claim:sample-v1")).status).toBe(
          "active",
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("failed migration rolls back and leaves the ledger unchanged", () => {
  const dir = directory();
  const path = join(dir, "interlock.db");
  try {
    const first = new StateStore(path);
    const run = sampleRun();
    first.saveRun(run);
    first.close();
    const failing = [
      ...embeddedMigrations,
      {
        tag: "9999_failing",
        sql: "CREATE TABLE should_not_exist (id TEXT);--> statement-breakpoint\nINSERT INTO missing_table VALUES ('x')",
      },
    ];
    expect(() => new StateStore(path, { migrations: failing })).toThrow("left unchanged");
    const reopened = new StateStore(path);
    try {
      expect(reopened.ledgerVersion).toBe(latestLedgerVersion);
      expect(reopened.run(run.ref)).toEqual(run);
    } finally {
      reopened.close();
    }
    const check = new Database(path, { readonly: true });
    const stray = check
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='should_not_exist'")
      .get();
    check.close();
    expect(stray).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("table rebuild migration preserves rows and foreign keys", () => {
  const dir = directory();
  const path = join(dir, "interlock.db");
  try {
    const first = new StateStore(path);
    const run = sampleRun();
    first.saveRun(run);
    first.saveClaim({
      ref: claimRefSchema.parse("interlock-claim:rebuild"),
      ticket: run.ticket,
      humanOwner: actorRefSchema.parse("human"),
      run: run.ref,
      previousState: { version: "1", payload: {} },
      claimedAt: run.createdAt,
      leaseExpiresAt: run.createdAt,
      status: "active",
    });
    first.close();
    const rebuild = [
      ...embeddedMigrations,
      {
        tag: "9998_rebuild_runs",
        sql: [
          "PRAGMA legacy_alter_table=ON",
          "ALTER TABLE runs RENAME TO runs_old",
          "CREATE TABLE runs (ref TEXT PRIMARY KEY, ticket TEXT NOT NULL, harness TEXT NOT NULL, model TEXT, effort TEXT, context TEXT, workspace_json TEXT NOT NULL, capabilities_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, execution_json TEXT)",
          "INSERT INTO runs SELECT * FROM runs_old",
          "DROP TABLE runs_old",
        ].join(";--> statement-breakpoint\n"),
      },
    ];
    const migrated = new StateStore(path, { migrations: rebuild });
    try {
      expect(migrated.ledgerVersion).toBe(rebuild.length);
      expect(migrated.run(run.ref)).toEqual(run);
      expect(migrated.claimForRun(run.ref).ref).toBe("interlock-claim:rebuild");
      expect(migrated.migrationBackupPath).toBeDefined();
      expect(existsSync(migrated.migrationBackupPath ?? "")).toBe(true);
    } finally {
      migrated.close();
    }
    const check = new Database(path, { readonly: true });
    expect(check.query("PRAGMA foreign_key_check").all()).toEqual([]);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger migrated by a newer Interlock is refused naming both versions and the backup", () => {
  const dir = directory();
  const path = join(dir, "interlock.db");
  try {
    const first = new StateStore(path);
    first.close();
    const newer = new Database(path);
    newer
      .query("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run("from-the-future", Date.now());
    newer.close();
    let message = "";
    try {
      new StateStore(path);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`version ${latestLedgerVersion + 1}`);
    expect(message).toContain(`version ${latestLedgerVersion}`);
    expect(message).toContain("Backup:");
    expect(message).toContain("refusing");
    const backupPath = message.split("Backup:")[1]?.trim() ?? "";
    expect(existsSync(backupPath)).toBe(true);
    const check = new Database(path, { readonly: true });
    const count = check
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM __drizzle_migrations")
      .get();
    check.close();
    expect(count?.count).toBe(latestLedgerVersion + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
