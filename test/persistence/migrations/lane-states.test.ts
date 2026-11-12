import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneRefSchema } from "../../../src/domain/refs/identifiers.ts";
import { embeddedMigrations } from "../../../src/persistence/migrate.ts";
import { StateStore } from "../../../src/persistence/state.ts";

test("loading the ledger maps stored queued and claimed lanes to implementing", () => {
  const directory = mkdtempSync(join(tmpdir(), "interlock-lane-states-"));
  const path = join(directory, "state.db");
  try {
    new StateStore(path, { migrations: embeddedMigrations.slice(0, 7) }).close();
    const database = new Database(path);
    const rows = [
      ["queued", "queued", null, null],
      ["claimed", "claimed", "interlock-run:claimed", null],
      ["held-queued", "attention", null, "queued"],
      ["held-claimed", "attention", "interlock-run:held", "claimed"],
      ["reviewing", "reviewing", "interlock-run:reviewing", null],
    ] as const;
    for (const [key, state, run, previous] of rows)
      database
        .query(
          "INSERT INTO lanes(id,ticket,run_ref,state,previous_state,evidence_json,review_round,max_review_rounds,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          `interlock-lane:${key}`,
          `jira:x:W:ticket:${key}`,
          run,
          state,
          previous,
          "[]",
          0,
          3,
          "2026-01-01T00:00:00Z",
          "2026-01-01T00:00:00Z",
        );
    database.close();
    const store = new StateStore(path);
    try {
      const lane = (key: string) => store.lane(laneRefSchema.parse(`interlock-lane:${key}`));
      expect(lane("queued")).toMatchObject({ state: "implementing" });
      expect(lane("queued").run).toBeUndefined();
      expect(lane("claimed")).toMatchObject({
        state: "implementing",
        run: "interlock-run:claimed",
      });
      expect(lane("held-queued")).toMatchObject({
        state: "attention",
        previousState: "implementing",
      });
      expect(lane("held-claimed")).toMatchObject({
        state: "attention",
        previousState: "implementing",
      });
      expect(lane("reviewing").state).toBe("reviewing");
      expect(store.listLanes()).toHaveLength(rows.length);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
