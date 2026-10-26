import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { claimRefSchema, laneRefSchema, runRefSchema } from "../domain/identifiers.ts";
import type { ClaimRef, LaneRef, RunRef } from "../domain/model.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { databasePath } from "./paths.ts";
import { StateStore } from "./state.ts";

export function withStore<T>(services: RuntimeServices, operation: (store: StateStore) => T): T {
  const path = services.statePath ?? databasePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const store = new StateStore(path);
  try {
    return operation(store);
  } finally {
    store.close();
  }
}
export function runRef(value: string): RunRef {
  return runRefSchema.parse(value.startsWith("interlock-run:") ? value : `interlock-run:${value}`);
}
export function laneRef(value: string): LaneRef {
  return laneRefSchema.parse(
    value.startsWith("interlock-lane:") ? value : `interlock-lane:${value}`,
  );
}
export function claimRef(value: string): ClaimRef {
  return claimRefSchema.parse(
    value.startsWith("interlock-claim:") ? value : `interlock-claim:${value}`,
  );
}
