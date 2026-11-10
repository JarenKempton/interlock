import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { heldClaim } from "../../../src/adapters/git/claim-lock.ts";
import type { CommandResult } from "../../../src/adapters/git/workspace.ts";
import { createApplication } from "../../../src/app/application.ts";
import { PickupResultError } from "../../../src/execution/pickup/coordinator.ts";
import { StateStore } from "../../../src/persistence/state.ts";
import { GIT_TEST_TIMEOUT_MS, ScriptedGit } from "../../fixtures/git/remote.ts";
import {
  first,
  inspect,
  lock,
  pickupRuntimeFixtures,
  ref,
} from "../../fixtures/pickup/runtime-suite.ts";

const fixture = pickupRuntimeFixtures();

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
