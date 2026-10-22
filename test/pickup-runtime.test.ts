import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitClaimLock, heldClaim } from "../src/adapters/claims/git-lock.ts";
import { createApplication } from "../src/application.ts";
import { ticketRefSchema } from "../src/domain/identifiers.ts";
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
  return new GitClaimLock({ repository: f.remote.alice, remote: "origin", git: f.git });
}
function inspect<T>(f: Awaited<ReturnType<typeof fixture>>, read: (store: StateStore) => T): T {
  const store = new StateStore(f.state);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

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
    expect(result.reviewers.correctness?.model).toBe("test-model");
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
    expect(inspect(f, (s) => s.run(result.run)).execution).toBeUndefined();
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

test(
  "collision never alters another owner's remote claim or Jira",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const first = await app.pickup.execute(f.input);
    if (!("claim" in first)) throw new Error("Expected claim");
    f.jira.issue.fields.assignee = null;
    f.jira.issue.fields.status.name = "To Do";
    const before = await lock(f).read(ref);
    const calls = f.jira.calls.length;
    await expect(app.pickup.execute(f.input)).rejects.toBeInstanceOf(PickupResultError);
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

test.each(["stale", "missing", "ambiguous", "disabled", "option", "reviewer"])(
  "invalid %s catalog selection fails before tracker or ledger access",
  async (failure) => {
    const f = await fixture();
    const catalog = catalogEnvelope();
    if (failure === "stale") catalog.observedAt = "2000-01-01T00:00:00.000Z";
    if (failure === "missing") first(catalog.catalog.providers).models = [];
    if (failure === "ambiguous") catalog.catalog.providers.push(first(catalog.catalog.providers));
    if (failure === "disabled") first(catalog.catalog.providers).canRunChildTask = false;
    if (failure === "option") first(catalog.catalog.inheritedOptions).value = "unsupported";
    if (failure === "reviewer")
      await writeFile(
        f.config,
        (await readFile(f.config, "utf8")).replace(
          '[roles.reviewers.correctness]\nprovider = "codex"\nmodel = "test-model"',
          '[roles.reviewers.correctness]\nprovider = "codex"\nmodel = "missing"',
        ),
      );
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
