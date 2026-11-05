import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savedT3Configuration } from "../../src/adapters/hosts/t3-legacy.ts";
import {
  resolveConfiguration,
  validateExecutionConfiguration,
} from "../../src/configuration/schema.ts";
import { runRefSchema } from "../../src/domain/identifiers.ts";
import { embeddedMigrations, migrateLedger } from "../../src/persistence/migrate.ts";
import { StateStore } from "../../src/persistence/state.ts";

test("upgrading legacy T3 runs preserves known harnesses and marks absent evidence unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "interlock-vocabulary-"));
  const path = join(dir, "ledger.db");
  try {
    const db = new Database(path);
    migrateLedger(db, path, embeddedMigrations.slice(0, 5));
    for (const [key, oldHarness, plan] of [
      ["codex", "t3", "codex"],
      ["claude", "t3", "claudeAgent"],
      ["missing", "t3", null],
      ["invalid", "t3", "t3"],
      ["direct", "codex", null],
    ] as const) {
      const ref = `interlock-run:${key}`;
      db.query(
        "INSERT INTO runs(ref,ticket,harness,workspace_json,capabilities_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        ref,
        "jira:x:W:ticket:A",
        oldHarness,
        "{}",
        "{}",
        "claimed",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );
      if (plan)
        db.query(
          "INSERT INTO transaction_steps(run_ref,state,receipt_json,occurred_at) VALUES(?,?,?,?)",
        ).run(
          ref,
          "claimed",
          JSON.stringify({ plan: { modelSelection: { provider: plan } } }),
          "2026-01-01T00:00:00Z",
        );
    }
    db.query("INSERT INTO user_settings(name,value) VALUES(?,?)").run("agent", "codex");
    db.query("INSERT INTO user_settings(name,value) VALUES(?,?)").run(
      "reviewer_agent",
      "claudeAgent",
    );
    const snapshot = JSON.stringify(
      resolveConfiguration(undefined, { harness: "codex" }),
    ).replaceAll('"harness"', '"agent"');
    db.query("INSERT INTO execution_configurations(run_ref,snapshot_json) VALUES(?,?)").run(
      "interlock-run:codex",
      snapshot,
    );
    db.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new StateStore(path);
      try {
        for (const [key, host, harness] of [
          ["codex", "t3", "codex"],
          ["claude", "t3", "claude"],
          ["missing", "t3", "unknown"],
          ["invalid", "t3", "unknown"],
          ["direct", "unknown", "codex"],
        ]) {
          expect(store.run(runRefSchema.parse(`interlock-run:${key}`))).toMatchObject({
            host,
            harness,
            status: "claimed",
          });
        }
        expect(store.userSettings()).toEqual({ harness: "codex", reviewer_harness: "claudeAgent" });
        expect(
          store.getExecutionConfiguration(runRefSchema.parse("interlock-run:codex"))?.settings
            .harness,
        ).toBe("codex");
        if (attempt === 1) expect(store.migrationBackupPath).toBeUndefined();
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy configuration translation preserves namespace keys and rejects conflicting choices", () => {
  expect(
    savedT3Configuration({
      project: { maps: { agent: "keep" }, t3: { provider: "codex" } },
      settings: { agent: "codex" },
      sources: { agent: "default" },
    }),
  ).toEqual({
    project: { maps: { agent: "keep" }, t3: { harness: "codex" } },
    settings: { harness: "codex" },
    sources: { harness: "default" },
  });
  expect(() => savedT3Configuration({ settings: { agent: "codex", harness: "claude" } })).toThrow(
    "Conflicting",
  );
  const current = resolveConfiguration(undefined, { harness: "codex" });
  expect(validateExecutionConfiguration(savedT3Configuration(current))).toEqual(current);
});
