import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embeddedMigrations, ledgerVersion } from "../../../src/persistence/migrate.ts";
import { StateStore } from "../../../src/persistence/state.ts";

for (const populated of [false, true]) {
  test(`retirement removal migration ${populated ? "refuses and names every retained lane" : "drops an empty table"}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "interlock-retirement-migration-"));
    const path = join(directory, "state.db");
    try {
      new StateStore(path, { migrations: embeddedMigrations.slice(0, 6) }).close();
      if (populated) {
        const database = new Database(path);
        for (const lane of ["interlock-lane:one", "interlock-lane:two"])
          database.query("INSERT INTO retirements VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            lane,
            lane,
            "/worktree",
            "/repo",
            "task/KEY",
            JSON.stringify({
              retainedRef: `refs/retained/${lane}`,
              preservedFiles: "/preserved",
            }),
            "branch_removed",
          );
        database.close();
        expect(() => new StateStore(path)).toThrow("interlock-lane:one, interlock-lane:two");
        const unchanged = new Database(path, { readonly: true });
        expect(ledgerVersion(unchanged)).toBe(6);
        expect(unchanged.query("SELECT plan_json FROM retirements").all()).toHaveLength(2);
        unchanged.close();
      } else {
        new StateStore(path).close();
        const migrated = new Database(path, { readonly: true });
        expect(ledgerVersion(migrated)).toBe(embeddedMigrations.length);
        expect(
          migrated.query("SELECT name FROM sqlite_master WHERE name='retirements'").get(),
        ).toBeNull();
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
