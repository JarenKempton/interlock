import { afterEach, expect } from "bun:test";
import { GitClaimLock } from "../../../src/adapters/git/claim-lock.ts";
import { configurationOperations } from "../../../src/configuration/project-files.ts";
import { normalizeClaimHome } from "../../../src/domain/claim/home.ts";
import { ticketRefSchema } from "../../../src/domain/refs/identifiers.ts";
import { StateStore } from "../../../src/persistence/state.ts";
import { pickupFixture } from "./runtime.ts";

export function pickupRuntimeFixtures() {
  const fixtures: Awaited<ReturnType<typeof pickupFixture>>[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((f) => f.dispose()));
  });
  return async function fixture() {
    const f = await pickupFixture();
    fixtures.push(f);
    return f;
  };
}

export const ref = ticketRefSchema.parse("jira:example:TEST:ticket:TEST-492");

export function lock(f: Awaited<ReturnType<typeof pickupFixture>>) {
  return homeLock(f, f.remote.remote);
}

export function homeLock(f: Awaited<ReturnType<typeof pickupFixture>>, home: string) {
  return new GitClaimLock({
    repository: f.remote.alice,
    home: normalizeClaimHome(home),
    git: f.git,
  });
}

export async function configure(
  f: Awaited<ReturnType<typeof pickupFixture>>,
  key: string,
  value: string,
) {
  expect((await f.git.run(["git", "config", key, value], f.remote.alice)).exitCode).toBe(0);
}

export function inspect<T>(
  f: Awaited<ReturnType<typeof pickupFixture>>,
  read: (store: StateStore) => T,
): T {
  const store = new StateStore(f.state);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

export function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

export async function configureUserHome(
  f: Awaited<ReturnType<typeof pickupFixture>>,
  value: string,
) {
  await configurationOperations({ cwd: f.root, statePath: f.state }).edit({
    path: f.config,
    set: ["claim-home", value],
  });
}
