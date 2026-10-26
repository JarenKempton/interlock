import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { embeddedMigrations } from "../src/persistence/migrations/embedded.ts";

const target = process.argv[2] ?? "test/fixtures/ledgers/v1.db";
mkdirSync(dirname(target), { recursive: true });
rmSync(target, { force: true });
const database = new Database(target, { create: true });
for (const statement of (embeddedMigrations[0]?.sql ?? "").split("--> statement-breakpoint")) {
  const trimmed = statement.trim();
  if (trimmed) database.exec(trimmed);
}
const now = "2026-01-01T00:00:00.000Z";
database
  .query(
    "INSERT INTO runs(ref,ticket,harness,model,workspace_json,capabilities_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
  )
  .run(
    "interlock-run:sample-v1",
    "jira:sample:LEDGER:ticket:V1",
    "codex",
    null,
    JSON.stringify({ path: "/tmp/sample-work" }),
    JSON.stringify({}),
    "claimed",
    now,
    now,
  );
database
  .query(
    "INSERT INTO claims(ref,ticket,human_owner,run_ref,previous_state_json,claimed_at,lease_expires_at,status,current_version) VALUES(?,?,?,?,?,?,?,?,?)",
  )
  .run(
    "interlock-claim:sample-v1",
    "jira:sample:LEDGER:ticket:V1",
    "human",
    "interlock-run:sample-v1",
    JSON.stringify({ version: "1", payload: { status: "To Do" } }),
    now,
    now,
    "active",
    "1",
  );
database.close();
console.log(target);
