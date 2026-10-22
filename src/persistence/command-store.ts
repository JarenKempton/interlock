import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  claimRefSchema,
  groupRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
  workspaceRefSchema,
} from "../domain/identifiers.ts";
import type { ClaimRef, RunRef } from "../domain/model.ts";
import { parseRef } from "../domain/reference.ts";
import type { FrontierScope } from "../frontier/evaluate.ts";
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
export function claimRef(value: string): ClaimRef {
  return claimRefSchema.parse(
    value.startsWith("interlock-claim:") ? value : `interlock-claim:${value}`,
  );
}
export function parseScope(raw: string | undefined): FrontierScope {
  if (!raw) return {};
  const parsed = parseRef(raw);
  if (parsed.kind === "workspace") return { workspace: workspaceRefSchema.parse(parsed.raw) };
  if (parsed.kind === "group") return { group: groupRefSchema.parse(parsed.raw) };
  if (parsed.kind === "map") return { map: mapRefSchema.parse(parsed.raw) };
  if (parsed.kind === "ticket") return { ticket: ticketRefSchema.parse(parsed.raw) };
  throw new Error(`${raw} is not a frontier scope`);
}
