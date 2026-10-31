import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { GitClaimLock, heldClaim } from "../src/adapters/claims/git-lock.ts";
import type { CommandResult } from "../src/adapters/workspaces/git.ts";
import { createApplication } from "../src/application.ts";
import { readUserSettings } from "../src/configuration/local-settings.ts";
import { configurationOperations } from "../src/configuration/project-files.ts";
import { normalizeClaimHome } from "../src/domain/claim-home.ts";
import { ticketRefSchema } from "../src/domain/identifiers.ts";
import type { Claim } from "../src/domain/model.ts";
import { PickupResultError } from "../src/execution/pickup.ts";
import { StateStore } from "../src/persistence/state.ts";
import { GIT_TEST_TIMEOUT_MS, ScriptedGit } from "./fixtures/git-remote.ts";
import { catalogEnvelope, pickupFixture } from "./fixtures/pickup-runtime.ts";

const fixtures: Awaited<ReturnType<typeof pickupFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()));
});
async function fixture() {
  const f = await pickupFixture();
  fixtures.push(f);
  return f;
}
const ref = ticketRefSchema.parse("jira:example:TEST:ticket:TEST-492");
function lock(f: Awaited<ReturnType<typeof fixture>>) {
  return homeLock(f, f.remote.remote);
}
function homeLock(f: Awaited<ReturnType<typeof fixture>>, home: string) {
  return new GitClaimLock({
    repository: f.remote.alice,
    home: normalizeClaimHome(home),
    git: f.git,
  });
}
async function configure(f: Awaited<ReturnType<typeof fixture>>, key: string, value: string) {
  expect((await f.git.run(["git", "config", key, value], f.remote.alice)).exitCode).toBe(0);
}
function inspect<T>(f: Awaited<ReturnType<typeof fixture>>, read: (store: StateStore) => T): T {
  const store = new StateStore(f.state);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

test.each(["absent-return", "absent-throw", "released-return", "released-throw"])(
  "a delayed claim push retains recovery evidence while the remote is unchanged: %s",
  async (scenario) => {
    const f = await fixture();
    if (scenario.startsWith("released")) {
      const app = createApplication(f.services);
      const picked = await app.pickup.execute(f.input);
      if (!("claim" in picked)) throw new Error("Expected claim");
      await app.claim.release.execute({ claim: picked.claim, state: f.state });
    }
    const before = await lock(f).read(ref);
    const writesBefore = f.jira.calls.length;
    const git = new ScriptedGit(f.git);
    let finishPush: (() => Promise<CommandResult>) | undefined;
    git.push = async (run) => {
      finishPush = run;
      if (scenario.endsWith("throw")) throw new Error("connection lost");
      return { exitCode: 128, stdout: "", stderr: "connection lost" };
    };
    f.services.execution = { ...f.services.execution, git };
    const failure = await createApplication(f.services)
      .pickup.execute(f.input)
      .catch((e) => e);
    if (!(failure instanceof PickupResultError)) throw new Error("Expected pickup failure");
    const receipt = failure.receipt;
    expect(receipt.state).toBe("recovery_required");
    expect(await lock(f).read(ref)).toEqual(before);
    expect(
      f.jira.calls
        .slice(writesBefore)
        .filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call)),
    ).toEqual([]);
    if (!finishPush) throw new Error("Expected a pending push");
    expect((await finishPush()).exitCode).toBe(0);
    expect(heldClaim(await lock(f).read(ref))?.claim).toBe(receipt.claim);
    expect(inspect(f, (s) => s.run(receipt.run)).status).toBe("recovery_required");
    expect(inspect(f, (s) => s.recoveryEvidence(receipt.run))).toHaveLength(1);
    expect(() => inspect(f, (s) => s.claimForRun(receipt.run))).toThrow("Claim not found");
    expect(JSON.stringify(inspect(f, (s) => s.steps(receipt.run)))).toContain(
      "push outcome is unknown",
    );
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each(["remote-read", "commit-preparation"])(
  "catalog expiry during final %s prevents the claim push",
  async (stage) => {
    const f = await fixture();
    const catalog = catalogEnvelope();
    await writeFile(f.t3Catalog, JSON.stringify(catalog));
    const observed = Date.parse(catalog.observedAt);
    let now = observed;
    let claiming = false;
    class ClaimingStore extends StateStore {
      override recordStep(...args: Parameters<StateStore["recordStep"]>) {
        super.recordStep(...args);
        if (args[1] === "claiming") claiming = true;
      }
    }
    let pushes = 0;
    f.services.execution = {
      ...f.services.execution,
      clock: { now: () => new Date(now) },
      openStore: (path) => new ClaimingStore(path),
      git: {
        async run(argv, cwd) {
          if (argv[1] === "push") pushes += 1;
          const result = await f.git.run(argv, cwd);
          if (
            (stage === "remote-read" && claiming && argv[1] === "ls-remote") ||
            (stage === "commit-preparation" && argv.includes("commit-tree"))
          )
            now = observed + 60_001;
          return result;
        },
      },
    };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow("catalog");
    expect(now).toBe(observed + 60_001);
    expect(pushes).toBe(0);
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(f.jira.property).toBeNull();
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "dry-run returns T3 arguments and AC with no ledger, workspace, mirror or remote lock mutation",
  async () => {
    const f = await fixture();
    const result = await createApplication(f.services).pickup.execute({
      ...f.input,
      "dry-run": true,
    });
    expect(result).toMatchObject({
      state: "planned",
      dryRun: true,
      branch: "task/TEST-492",
      worktree: f.worktree,
    });
    expect(result.launch).toMatchObject({
      message: result.prompt,
      modelSelection: {
        instanceId: "codex",
        model: "test-model",
        options: { reasoningEffort: "high" },
      },
      workspaceStrategy: { type: "existing_worktree", worktreePath: f.worktree },
    });
    expect(result.prompt).toContain("- Claim before creating a worktree.");
    expect(result.reviewers).toEqual({});
    expect(existsSync(f.state)).toBe(false);
    expect(existsSync(f.worktree)).toBe(false);
    expect(f.jira.property).toBeNull();
    expect((await lock(f).read(ref)).version).toBe("absent");
    expect(f.jira.calls.filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call))).toEqual(
      [],
    );
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "pickup verifies Git lock and Jira before worktree creation, records claimed, and releases with readback",
  async () => {
    const f = await fixture();
    const calls: string[][] = [];
    const git = f.git;
    f.services.execution = {
      ...f.services.execution,
      git: {
        async run(argv, cwd) {
          calls.push([...argv]);
          if (argv[1] === "worktree" && argv[2] === "add") {
            expect(heldClaim(await lock(f).read(ref))).toBeDefined();
            expect(f.jira.issue.fields.status.name).toBe("In Progress");
            expect(f.jira.issue.fields.assignee?.accountId).toBe("test-owner");
          }
          return git.run(argv, cwd);
        },
      },
    };
    const app = createApplication(f.services);
    const result = await app.pickup.execute(f.input);
    if (!("run" in result)) throw new Error("Expected a claimed plan");
    expect(result.state).toBe("claimed");
    expect(existsSync(f.worktree)).toBe(true);
    expect(inspect(f, (s) => s.run(result.run))).toMatchObject({
      status: "claimed",
      workspace: { path: f.worktree, branch: "task/TEST-492" },
    });
    expect((await app.runs.list.execute({ state: f.state }))[0]?.status).toBe("claimed");
    await writeFile(join(f.worktree, "user.txt"), "keep me");
    const release = await app.claim.release.execute({ claim: result.claim, state: f.state });
    expect(release).toMatchObject({ state: "released", mirror: "restored_verified" });
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(f.jira.property).toBeNull();
    expect(f.jira.issue.fields.assignee).toBeNull();
    expect(f.jira.issue.fields.status.name).toBe("To Do");
    expect(inspect(f, (s) => s.run(result.run)).status).toBe("released");
    expect(await readFile(join(f.worktree, "user.txt"), "utf8")).toBe("keep me");
    expect(await app.claim.release.execute({ claim: result.claim, state: f.state })).toMatchObject({
      state: "released",
    });
    expect(calls.flat()).not.toContain("--no-verify");
    expect(calls.flat()).not.toContain("--force");
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each(["property", "assignment", "transition"])(
  "a delayed Jira %s claim write retains the lock and recovery evidence",
  async (stage) => {
    const f = await fixture();
    const request = f.jira.request.bind(f.jira);
    let finish: (() => Promise<unknown>) | undefined;
    f.jira.request = async (method, path, body) => {
      if (
        !finish &&
        ((stage === "property" && method === "PUT" && path.includes("/properties/")) ||
          (stage === "assignment" && method === "PUT" && path.endsWith("/assignee")) ||
          (stage === "transition" && method === "POST" && path.endsWith("/transitions")))
      ) {
        finish = () => request(method, path, body);
        throw new Error("Accepted Jira write remains pending");
      }
      return request(method, path, body);
    };
    const failure = await createApplication(f.services)
      .pickup.execute(f.input)
      .catch((error) => error);
    if (!(failure instanceof PickupResultError)) throw new Error("Expected pickup failure");
    expect(failure.receipt.state).toBe("recovery_required");
    expect(heldClaim(await lock(f).read(ref))?.claim).toBe(failure.receipt.claim);
    if (!finish) throw new Error("Expected pending Jira write");
    await finish();
    expect(heldClaim(await lock(f).read(ref))?.claim).toBe(failure.receipt.claim);
    expect(inspect(f, (s) => s.run(failure.receipt.run)).status).toBe("recovery_required");
    expect(inspect(f, (s) => s.recoveryEvidence(failure.receipt.run))).toHaveLength(1);
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each(["property", "assignment", "transition"])(
  "ambiguous Jira %s response compensates the real lock and mirror",
  async (step) => {
    const f = await fixture();
    let fired = false;
    f.jira.fail = (method, path, after) => {
      if (
        !fired &&
        after &&
        ((step === "property" && method === "PUT" && path.includes("/properties/")) ||
          (step === "assignment" && path.endsWith("/assignee")) ||
          (step === "transition" && method === "POST" && path.endsWith("/transitions")))
      ) {
        fired = true;
        throw new Error("response lost");
      }
    };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toMatchObject({
      receipt: { state: "compensated" },
    });
    expect(fired).toBe(true);
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(f.jira.property).toBeNull();
    expect(f.jira.issue.fields.assignee).toBeNull();
    expect(f.jira.issue.fields.status.name).toBe("To Do");
    expect(inspect(f, (s) => s.listRuns()[0]?.status)).toBe("compensated");
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "workspace conflict compensates without deleting existing unregistered data",
  async () => {
    const f = await fixture();
    await f.existingWorkspace();
    const git = f.git;
    f.services.execution = {
      ...f.services.execution,
      git: {
        async run(argv, cwd) {
          if (argv[1] === "worktree" && argv[2] === "list")
            return { exitCode: 0, stdout: "", stderr: "" };
          return git.run(argv, cwd);
        },
      },
    };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toMatchObject({
      receipt: { state: "compensated" },
    });
    expect(await readFile(join(f.worktree, "user-work.txt"), "utf8")).toBe("preserve me");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "final ledger failure compensates while preserving an existing dirty workspace",
  async () => {
    const f = await fixture();
    await f.existingWorkspace();
    class FailingStore extends StateStore {
      override commitRun(...args: Parameters<StateStore["commitRun"]>) {
        if (args[1] === "prepared") throw new Error("ledger failed");
        return super.commitRun(...args);
      }
    }
    f.services.execution = { ...f.services.execution, openStore: (path) => new FailingStore(path) };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toMatchObject({
      receipt: { state: "compensated" },
    });
    expect(await readFile(join(f.worktree, "user-work.txt"), "utf8")).toBe("preserve me");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(inspect(f, (s) => s.claimForRun(first(s.listRuns()).ref)).status).toBe("released");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "refused restoration retains lock and durable recovery evidence",
  async () => {
    const f = await fixture();
    f.jira.fail = (method, path, after) => {
      if (after && method === "POST" && path.endsWith("/transitions")) {
        f.jira.issue.fields.assignee = { accountId: "human-edit" };
        throw new Error("verification failed");
      }
    };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toMatchObject({
      receipt: { state: "recovery_required" },
    });
    expect(heldClaim(await lock(f).read(ref))).toBeDefined();
    expect(inspect(f, (s) => s.listRuns()[0]?.status)).toBe("recovery_required");
    expect(inspect(f, (s) => s.recoveryEvidence(first(s.listRuns()).ref))).toHaveLength(1);
    expect(f.jira.issue.fields.assignee?.accountId).toBe("human-edit");
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each([
  ["property", "already claimed through claim home"],
  ["lock", "already claimed in claim home"],
])(
  "a held %s refuses pickup without altering the remote claim or Jira",
  async (marker, message) => {
    const f = await fixture();
    const app = createApplication(f.services);
    const first = await app.pickup.execute(f.input);
    if (!("claim" in first)) throw new Error("Expected claim");
    f.jira.issue.fields.assignee = null;
    f.jira.issue.fields.status.name = "To Do";
    if (marker === "lock") f.jira.property = null;
    const before = await lock(f).read(ref);
    const calls = f.jira.calls.length;
    await expect(app.pickup.execute(f.input)).rejects.toThrow(
      `${message} ${normalizeClaimHome(f.remote.remote).identity}`,
    );
    expect(await lock(f).read(ref)).toEqual(before);
    expect(
      f.jira.calls.slice(calls).filter((c) => c.startsWith("PUT") || c.startsWith("DELETE")),
    ).toEqual([]);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a lost successful Git push response is resolved by readback",
  async () => {
    const f = await fixture();
    const git = new ScriptedGit(f.git);
    git.push = async (run) => {
      await run();
      return { exitCode: 1, stdout: "", stderr: "connection lost" };
    };
    f.services.execution = { ...f.services.execution, git };
    expect((await createApplication(f.services).pickup.execute(f.input)).state).toBe("claimed");
    expect(heldClaim(await lock(f).read(ref))).toBeDefined();
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release refuses another actor before writes and recovers after a lost release receipt",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const result = await app.pickup.execute(f.input);
    if (!("claim" in result)) throw new Error("Expected claim");
    f.jira.owner = "someone-else";
    await expect(app.claim.release.execute({ claim: result.claim })).rejects.toThrow(
      "recorded claim owner",
    );
    expect(heldClaim(await lock(f).read(ref))).toBeDefined();
    f.jira.owner = "test-owner";
    class FailingStore extends StateStore {
      override commitRelease() {
        throw new Error("commit failed");
      }
    }
    f.services.execution = { ...f.services.execution, openStore: (path) => new FailingStore(path) };
    await expect(
      createApplication(f.services).claim.release.execute({ claim: result.claim }),
    ).rejects.toThrow("requires recovery");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    delete f.services.execution.openStore;
    expect(
      (await createApplication(f.services).claim.release.execute({ claim: result.claim })).state,
    ).toBe("released");
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each(["stale", "missing", "ambiguous", "disabled", "option"])(
  "invalid %s catalog selection fails before tracker or ledger access",
  async (failure) => {
    const f = await fixture();
    const catalog = catalogEnvelope();
    if (failure === "stale") catalog.observedAt = "2000-01-01T00:00:00.000Z";
    if (failure === "missing") first(catalog.catalog.providers).models = [];
    if (failure === "ambiguous") catalog.catalog.providers.push(first(catalog.catalog.providers));
    if (failure === "disabled") first(catalog.catalog.providers).canRunChildTask = false;
    if (failure === "option") first(catalog.catalog.inheritedOptions).value = "unsupported";
    await writeFile(f.t3Catalog, JSON.stringify(catalog));
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow();
    expect(f.jira.calls).toEqual([]);
    expect(existsSync(f.state)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

test(
  "catalog expiry during preflight prevents the first remote claim write",
  async () => {
    const f = await fixture();
    const envelope = catalogEnvelope();
    await writeFile(f.t3Catalog, JSON.stringify(envelope));
    let now = Date.parse(envelope.observedAt);
    const git = f.git;
    f.services.execution = {
      ...f.services.execution,
      clock: { now: () => new Date(now) },
      git: {
        async run(argv, cwd) {
          const result = await git.run(argv, cwd);
          if (argv[1] === "ls-remote") now += 60_001;
          return result;
        },
      },
    };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      "catalog is stale",
    );
    expect((await lock(f).read(ref)).version).toBe("absent");
    expect(f.jira.property).toBeNull();
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "claim-ledger failure restores both remote authorities before workspace preparation",
  async () => {
    const f = await fixture();
    class FailingStore extends StateStore {
      override commitClaim() {
        throw new Error("claim commit failed");
      }
    }
    f.services.execution = { ...f.services.execution, openStore: (path) => new FailingStore(path) };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toMatchObject({
      receipt: { state: "compensated" },
    });
    expect((await lock(f).read(ref)).record?.action).toBe("release");
    expect(f.jira.property).toBeNull();
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each(["property", "assignment", "transition"])(
  "a delayed Jira %s compensation write survives restart in recovery evidence",
  async (stage) => {
    const f = await fixture();
    let compensating = false;
    f.services.execution = {
      ...f.services.execution,
      git: {
        async run(argv, cwd) {
          if (argv[1] === "worktree" && argv[2] === "add") {
            compensating = true;
            return { exitCode: 1, stdout: "", stderr: "workspace preparation failed" };
          }
          return f.git.run(argv, cwd);
        },
      },
    };
    const request = f.jira.request.bind(f.jira);
    let finish: (() => Promise<unknown>) | undefined;
    f.jira.request = async (method, path, body) => {
      if (
        compensating &&
        !finish &&
        ((stage === "property" && method === "DELETE" && path.includes("/properties/")) ||
          (stage === "assignment" && method === "PUT" && path.endsWith("/assignee")) ||
          (stage === "transition" && method === "POST" && path.endsWith("/transitions")))
      ) {
        finish = () => request(method, path, body);
        throw new Error("Accepted compensation remains pending");
      }
      return request(method, path, body);
    };
    const failure = await createApplication(f.services)
      .pickup.execute(f.input)
      .catch((error) => error);
    if (!(failure instanceof PickupResultError)) throw new Error("Expected pickup failure");
    expect(failure.receipt.state).toBe("recovery_required");
    const claim = failure.receipt.claim;
    await expect(createApplication(f.services).claim.release.execute({ claim })).rejects.toThrow(
      "requires recovery",
    );
    expect(heldClaim(await lock(f).read(ref))?.claim).toBe(claim);
    if (!finish) throw new Error("Expected pending compensation");
    await finish();
    expect((await createApplication(f.services).claim.release.execute({ claim })).state).toBe(
      "released",
    );
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(f.jira.property).toBeNull();
    expect(f.jira.issue.fields.assignee).toBeNull();
    expect(f.jira.issue.fields.status.name).toBe("To Do");
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each(["property", "assignment", "transition"])(
  "a delayed Jira %s release write blocks restart retries until it completes",
  async (stage) => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claim");
    const request = f.jira.request.bind(f.jira);
    let finish: (() => Promise<unknown>) | undefined;
    f.jira.request = async (method, path, body) => {
      if (
        !finish &&
        ((stage === "property" && method === "DELETE" && path.includes("/properties/")) ||
          (stage === "assignment" && method === "PUT" && path.endsWith("/assignee")) ||
          (stage === "transition" && method === "POST" && path.endsWith("/transitions")))
      ) {
        finish = () => request(method, path, body);
        throw new Error("Accepted restoration remains pending");
      }
      return request(method, path, body);
    };
    await expect(app.claim.release.execute({ claim: picked.claim })).rejects.toThrow(
      "requires recovery",
    );
    const writes = f.jira.calls.filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call));
    await expect(
      createApplication(f.services).claim.release.execute({ claim: picked.claim }),
    ).rejects.toThrow("requires recovery");
    expect(f.jira.calls.filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call))).toEqual(
      writes,
    );
    expect(heldClaim(await lock(f).read(ref))?.claim).toBe(picked.claim);
    expect(inspect(f, (s) => s.run(picked.run)).status).toBe("recovery_required");
    if (!finish) throw new Error("Expected pending Jira write");
    await finish();
    expect(
      (await createApplication(f.services).claim.release.execute({ claim: picked.claim })).state,
    ).toBe("released");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(f.jira.property).toBeNull();
    expect(f.jira.issue.fields.assignee).toBeNull();
    expect(f.jira.issue.fields.status.name).toBe("To Do");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release mirror failure retains lock and can be retried after readback",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    let failed = false;
    f.jira.fail = (method, path, after) => {
      if (!failed && after && method === "DELETE" && path.includes("/properties/")) {
        failed = true;
        throw new Error("release response lost");
      }
    };
    await expect(app.claim.release.execute({ claim: picked.claim })).rejects.toThrow(
      "requires recovery",
    );
    expect(heldClaim(await lock(f).read(ref))?.claim).toBe(picked.claim);
    expect(inspect(f, (s) => s.run(picked.run)).status).toBe("recovery_required");
    expect((await app.claim.release.execute({ claim: picked.claim })).state).toBe("released");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(existsSync(f.worktree)).toBe(true);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "an unavailable requested host fails before Jira access or any state change",
  async () => {
    const f = await fixture();
    await setUser(f, "host", "unavailable");
    const before = await readFile(f.state);
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      "Requested host is unavailable",
    );
    expect(f.jira.calls).toEqual([]);
    expect((await readFile(f.state)).equals(before)).toBe(true);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a ticket completed during tracker preflight is never claimed or reopened",
  async () => {
    const f = await fixture();
    let searches = 0;
    f.jira.fail = (method, path, after) => {
      if (!after && method === "POST" && path.endsWith("/search/jql") && ++searches === 3) {
        f.jira.issue.fields.status = { name: "Done", statusCategory: { key: "done" } };
      }
    };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      "not available",
    );
    expect(f.jira.issue.fields.status.name).toBe("Done");
    expect(f.jira.property).toBeNull();
    expect((await lock(f).read(ref)).version).toBe("absent");
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a ticket completed on the final mirror read is preserved and the held lock compensates",
  async () => {
    const f = await fixture();
    const git = f.git;
    let locked = false;
    f.services.execution = {
      ...f.services.execution,
      git: {
        async run(argv, cwd) {
          const result = await git.run(argv, cwd);
          if (argv[1] === "push") locked = true;
          return result;
        },
      },
    };
    f.jira.fail = (method, path, after) => {
      if (locked && !after && method === "GET" && path.includes("/issue/TEST-492?")) {
        f.jira.issue.fields.status = { name: "Done", statusCategory: { key: "done" } };
      }
    };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toMatchObject({
      receipt: { state: "compensated" },
    });
    expect(f.jira.issue.fields.status.name).toBe("Done");
    expect(f.jira.property).toBeNull();
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release uses the recorded repository, site and claimed status after shared config changes",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    await writeFile(f.config, '[statuses]\nclaimed = "Elsewhere"\n');
    expect((await app.claim.release.execute({ claim: picked.claim })).state).toBe("released");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release restores a claimed ticket even after its parent map is removed",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    Reflect.deleteProperty(f.jira.issue.fields, "parent");
    expect(
      (await f.git.run(["git", "branch", "-m", "main", "renamed-base"], f.remote.alice)).exitCode,
    ).toBe(0);
    expect((await app.claim.release.execute({ claim: picked.claim })).state).toBe("released");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(f.jira.property).toBeNull();
    expect(f.jira.issue.fields.assignee).toBeNull();
    expect(f.jira.issue.fields.status.name).toBe("To Do");
    expect(existsSync(f.worktree)).toBe(true);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release rejects repository origin drift before writing Jira or the lock",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    const calls = f.jira.calls.length;
    f.services.execution = {
      ...f.services.execution,
      git: {
        async run(argv, cwd) {
          if (argv.join(" ") === "git remote get-url origin")
            return { exitCode: 0, stdout: "https://github.com/other/repository.git", stderr: "" };
          return f.git.run(argv, cwd);
        },
      },
    };
    await expect(app.claim.release.execute({ claim: picked.claim })).rejects.toThrow(
      "Repository origin mismatch",
    );
    expect(heldClaim(await lock(f).read(ref))?.claim).toBe(picked.claim);
    expect(f.jira.calls.slice(calls).every((call) => call.startsWith("GET "))).toBe(true);
    expect(f.jira.issue.fields.status.name).toBe("In Progress");
  },
  GIT_TEST_TIMEOUT_MS,
);

function addBlocker(f: Awaited<ReturnType<typeof fixture>>, closed: boolean, external: boolean) {
  const blocker = structuredClone(f.jira.issue);
  blocker.key = "TEST-491";
  blocker.fields.issuelinks = [];
  blocker.fields.status = closed
    ? { name: "Done", statusCategory: { key: "done" } }
    : { name: "To Do", statusCategory: { key: "new" } };
  if (external) blocker.fields.parent.key = "TEST-471";
  f.jira.relatedIssues.push(blocker);
  f.jira.issue.fields.issuelinks.push({
    type: { inward: "is blocked by", outward: "blocks" },
    inwardIssue: { key: blocker.key, fields: { status: blocker.fields.status } },
  });
  return blocker;
}

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "pickup rejects an unfinished blocker (dry-run %s, external map %s) before side effects",
  async (dryRun, external) => {
    const f = await fixture();
    addBlocker(f, false, external);
    await expect(
      createApplication(f.services).pickup.execute({ ...f.input, "dry-run": dryRun }),
    ).rejects.toThrow("not available");
    expect((await lock(f).read(ref)).version).toBe("absent");
    expect(f.jira.property).toBeNull();
    expect(f.jira.issue.fields.status.name).toBe("To Do");
    expect(existsSync(f.state)).toBe(false);
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each([false, true])(
  "pickup accepts a completed blocker (external map %s)",
  async (external) => {
    const f = await fixture();
    addBlocker(f, true, external);
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    expect(picked.state).toBe("claimed");
    expect((await app.claim.release.execute({ claim: picked.claim })).state).toBe("released");
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each([false, true])(
  "pickup fails closed when blocker read is missing or unavailable (%s)",
  async (unavailable) => {
    const f = await fixture();
    addBlocker(f, true, true);
    if (unavailable) {
      f.jira.fail = (_method, path) => {
        if (path.includes("/issue/TEST-491?")) throw new Error("blocker unreadable");
      };
    } else f.jira.relatedIssues = [];
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow();
    expect((await lock(f).read(ref)).version).toBe("absent");
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each([false, true])(
  "pickup rechecks blockers during preflight and before mirroring (lock acquired %s)",
  async (afterLock) => {
    const f = await fixture();
    const blocker = addBlocker(f, true, true);
    const reopen = () => {
      blocker.fields.status = { name: "To Do", statusCategory: { key: "new" } };
    };
    if (afterLock) {
      f.services.execution = {
        ...f.services.execution,
        git: {
          async run(argv, cwd) {
            const result = await f.git.run(argv, cwd);
            if (argv[1] === "push") reopen();
            return result;
          },
        },
      };
    } else {
      let reads = 0;
      f.jira.fail = (method, path, after) => {
        if (!after && method === "GET" && path.includes("/issue/TEST-491?") && ++reads === 2)
          reopen();
      };
    }
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      "not available",
    );
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(f.jira.property).toBeNull();
    expect(f.jira.issue.fields.status.name).toBe("To Do");
    expect(existsSync(f.worktree)).toBe(false);
    if (afterLock) expect(inspect(f, (store) => store.listRuns()[0]?.status)).toBe("compensated");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release needs no Rank or map discovery",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    Reflect.deleteProperty(f.jira.issue.fields, "parent");
    Reflect.deleteProperty(f.jira.issue.fields, "customfield_rank");
    f.jira.fail = (_method, path) => {
      if (["/rest/api/3/field", "/rest/api/3/search/jql"].includes(path))
        throw new Error("pickup discovery unavailable");
    };
    expect((await app.claim.release.execute({ claim: picked.claim })).state).toBe("released");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(f.jira.property).toBeNull();
    expect(f.jira.issue.fields.assignee).toBeNull();
    expect(f.jira.issue.fields.status.name).toBe("To Do");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "fresh blocker issue state overrides stale completed search results",
  async () => {
    const f = await fixture();
    const blocker = addBlocker(f, true, true);
    const request = f.jira.request.bind(f.jira);
    let reads = 0;
    f.jira.request = async (method, path, body) => {
      const response = await request(method, path, body);
      if (method === "GET" && path.includes(`/issue/${blocker.key}?`)) {
        reads++;
        const fresh = structuredClone(blocker);
        fresh.fields.status = { name: "To Do", statusCategory: { key: "new" } };
        return { status: 200, body: fresh };
      }
      return response;
    };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      "not available",
    );
    expect(reads).toBeGreaterThan(0);
    expect((await lock(f).read(ref)).version).toBe("absent");
    expect(f.jira.property).toBeNull();
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "pickup refuses a rewritten claim home push without leaving a claim in either remote",
  async () => {
    const f = await fixture();
    const other = join(f.root, "other.git");
    expect((await f.git.run(["git", "init", "--bare", "--quiet", other], f.root)).exitCode).toBe(0);
    await configure(f, `url.${other}.pushInsteadOf`, f.remote.remote);
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      `claim home ${normalizeClaimHome(f.remote.remote).identity}`,
    );
    await configure(f, "--unset", `url.${other}.pushInsteadOf`);
    for (const remote of [f.remote.remote, other])
      expect((await homeLock(f, remote).read(ref)).version).toBe("absent");
    expect(f.jira.property).toBeNull();
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release refuses a rewritten claim home push before restoring Jira",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    const other = join(f.root, "other.git");
    expect((await f.git.run(["git", "init", "--bare", "--quiet", other], f.root)).exitCode).toBe(0);
    await configure(f, `url.${other}.pushInsteadOf`, f.remote.remote);
    const before = f.jira.calls.length;
    await expect(app.claim.release.execute({ claim: picked.claim })).rejects.toThrow(
      `claim home ${normalizeClaimHome(f.remote.remote).identity}`,
    );
    expect(f.jira.calls.slice(before).every((call) => call.startsWith("GET "))).toBe(true);
    expect(f.jira.property).toMatchObject({ claim: picked.claim });
    expect(f.jira.issue.fields.status.name).toBe("In Progress");
    await configure(f, "--unset", `url.${other}.pushInsteadOf`);
    expect(heldClaim(await lock(f).read(ref))?.claim).toBe(picked.claim);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "pickup prints the claim home and saves it from the first verified claim, never a dry run",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const home = normalizeClaimHome(f.remote.remote);
    const planned = await app.pickup.execute({ ...f.input, "dry-run": true });
    expect(planned.claimHome).toMatchObject({
      home: home.identity,
      url: home.url,
      source: expect.stringContaining("claim_home in interlock.toml on refs/heads/main at "),
      change: expect.stringContaining("interlock config edit --set claim-home VALUE"),
      lockRef: "refs/interlock/v2/example/TEST-492",
      recordVersion: 2,
    });
    expect(readUserSettings(f.state).claim_home).toBeUndefined();
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claim");
    expect(picked.claimHomeSaved).toBe(true);
    expect(readUserSettings(f.state).claim_home).toBe(home.url);
    const target = {
      claimHome: home.identity,
      claimHomeUrl: home.url,
      recordVersion: 2,
      lockRef: "refs/interlock/v2/example/TEST-492",
      configCommit: planned.claimHome.configCommit,
    };
    expect(inspect(f, (s) => s.claimForRun(picked.run))).toMatchObject(target);
    const claiming = z
      .object({ state: z.string(), receipt_json: z.string() })
      .array()
      .parse(inspect(f, (s) => s.steps(picked.run)))
      .find((step) => step.state === "claiming");
    expect(JSON.parse(claiming?.receipt_json ?? "null").receipt).toMatchObject(target);
    expect(heldClaim(await lock(f).read(ref))).toMatchObject({ home: home.identity, version: 2 });
    expect(f.jira.property).toMatchObject({ home: home.identity, version: 2 });
    await app.claim.release.execute({ claim: picked.claim, state: f.state });
    await configureUserHome(f, "someone/else");
    expect(readUserSettings(f.state).claim_home).toBe("https://github.com/someone/else.git");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "an existing claim-home setting is never overwritten by a claim",
  async () => {
    const f = await fixture();
    await configureUserHome(f, "someone/else");
    const picked = await createApplication(f.services).pickup.execute(f.input);
    expect(picked).toMatchObject({ claimHomeSaved: false });
    expect(readUserSettings(f.state).claim_home).toBe("https://github.com/someone/else.git");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release uses the saved claim home even after the configured home changes",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claim");
    const other = join(f.root, "other.git");
    expect((await f.git.run(["git", "init", "--bare", "--quiet", other], f.root)).exitCode).toBe(0);
    await writeFile(join(f.remote.alice, "interlock.toml"), `claim_home = '${other}'\n`);
    for (const argv of [
      ["add", "interlock.toml"],
      ["-c", "user.name=F", "-c", "user.email=f@invalid", "commit", "-m", "move home"],
      ["push", "--quiet", "origin", "main"],
    ])
      expect((await f.git.run(["git", ...argv], f.remote.alice)).exitCode).toBe(0);
    await configureUserHome(f, other);
    await app.claim.release.execute({ claim: picked.claim, state: f.state });
    expect((await lock(f).read(ref)).record?.action).toBe("release");
    expect((await homeLock(f, other).read(ref)).version).toBe("absent");
    expect(f.jira.property).toBeNull();
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each([
  [
    "before claim homes",
    (claim: Claim): Claim => {
      const { claimHome: _, claimHomeUrl: __, lockRef: ___, ...v1 } = claim;
      return v1;
    },
    "was made before claim homes; remove the interlock.claim property from TEST-492 and refs/interlock/claims/TEST-492 from the claim remote",
  ],
  [
    "by a newer Interlock",
    (claim: Claim): Claim => ({ ...claim, recordVersion: 3 }),
    "has record version 3; upgrade Interlock to release it",
  ],
])(
  "release refuses a claim recorded %s without touching Jira or the lock",
  async (_, recorded, message) => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claim");
    const before = await lock(f).read(ref);
    inspect(f, (s) => {
      s.saveClaim(recorded(s.claimForRun(picked.run)));
    });
    const calls = f.jira.calls.length;
    await expect(
      app.claim.release.execute({ claim: picked.claim, state: f.state }),
    ).rejects.toThrow(message);
    expect(f.jira.calls.length).toBe(calls);
    expect(await lock(f).read(ref)).toEqual(before);
  },
  GIT_TEST_TIMEOUT_MS,
);

async function setUser(
  f: Awaited<ReturnType<typeof fixture>>,
  name: "host" | "branch" | "pickable_statuses" | "claimed_status" | "jira_site",
  value: string,
) {
  await configurationOperations({ cwd: f.root, statePath: f.state }).edit({
    path: f.config,
    set: [name, value],
  });
}

async function configureUserHome(f: Awaited<ReturnType<typeof fixture>>, value: string) {
  await configurationOperations({ cwd: f.root, statePath: f.state }).edit({
    path: f.config,
    set: ["claim-home", value],
  });
}

test(
  "pickup runs in the current repo with no interlock.toml, using the signed-in Jira site",
  async () => {
    const f = await fixture();
    await setUser(f, "jira_site", "https://example.atlassian.net");
    f.services.configuration = { cwd: f.remote.alice };
    Reflect.deleteProperty(f.jira.issue.fields, "parent");
    const result = await createApplication(f.services).pickup.execute({
      key: "TEST-492",
      state: f.state,
      "t3-catalog": f.t3Catalog,
      "dry-run": true,
    });
    expect(result).toMatchObject({
      state: "planned",
      repository: "alice",
      branch: "task/TEST-492",
      worktree: f.worktree,
    });
    expect(result.prompt).not.toContain("Map:");
    expect(existsSync(join(f.remote.alice, "interlock.toml"))).toBe(true);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "pickup without a Jira site names login and the user setting",
  async () => {
    const f = await fixture();
    await writeFile(f.config, "version = 2\n");
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      "run interlock login jira or interlock config edit --set jira_site URL",
    );
    expect(f.jira.calls).toEqual([]);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a branch template or --branch names the branch, which is recorded for the run",
  async () => {
    const f = await fixture();
    await setUser(f, "branch", "feature/{key}-work");
    const app = createApplication(f.services);
    const planned = await app.pickup.execute({ ...f.input, "dry-run": true });
    expect(planned.branch).toBe("feature/TEST-492-work");
    const picked = await app.pickup.execute({ ...f.input, branch: "fix/TEST-492" });
    if (!("run" in picked)) throw new Error("Expected a claimed plan");
    expect(picked.launch.workspaceStrategy.branch).toBe("fix/TEST-492");
    expect(inspect(f, (s) => s.run(picked.run)).workspace.branch).toBe("fix/TEST-492");
    expect((await f.git.run(["git", "branch", "--show-current"], f.worktree)).stdout.trim()).toBe(
      "fix/TEST-492",
    );
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each([
  ["fix/other", "must contain TEST-492"],
  ["bad..TEST-492", "not a valid Git branch name"],
])(
  "--branch %s is refused before tracker access",
  async (branch, message) => {
    const f = await fixture();
    await expect(
      createApplication(f.services).pickup.execute({ ...f.input, branch }),
    ).rejects.toThrow(message);
    expect(f.jira.calls).toEqual([]);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "shared statuses override user statuses, which override the defaults",
  async () => {
    const f = await fixture();
    f.jira.issue.fields.status.name = "Ready";
    const app = createApplication(f.services);
    await expect(app.pickup.execute({ ...f.input, "dry-run": true })).rejects.toThrow(
      "unassigned ticket in To Do",
    );
    await setUser(f, "pickable_statuses", "Ready, To Do");
    expect((await app.pickup.execute({ ...f.input, "dry-run": true })).state).toBe("planned");
    await writeFile(
      f.config,
      `${await readFile(f.config, "utf8")}[statuses]\npickable = ["To Do"]\nclaimed = "Doing"\n`,
    );
    await expect(app.pickup.execute({ ...f.input, "dry-run": true })).rejects.toThrow(
      "unassigned ticket in To Do",
    );
    f.jira.issue.fields.status.name = "To Do";
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected a claimed plan");
    expect(f.jira.issue.fields.status.name).toBe("Doing");
    expect((await app.claim.release.execute({ claim: picked.claim })).state).toBe("released");
    expect(f.jira.issue.fields.status.name).toBe("To Do");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "an unfinished blocker still blocks a ticket with no parent epic",
  async () => {
    const f = await fixture();
    Reflect.deleteProperty(f.jira.issue.fields, "parent");
    const blocker = structuredClone(f.jira.issue);
    blocker.key = "TEST-491";
    f.jira.relatedIssues.push(blocker);
    f.jira.issue.fields.issuelinks = [
      {
        type: { inward: "is blocked by", outward: "blocks" },
        inwardIssue: { key: "TEST-491", fields: { status: blocker.fields.status } },
      },
    ];
    await expect(
      createApplication(f.services).pickup.execute({ ...f.input, "dry-run": true }),
    ).rejects.toThrow("unfinished dependencies block pickup");
  },
  GIT_TEST_TIMEOUT_MS,
);
