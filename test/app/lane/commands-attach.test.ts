import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitClaimLock } from "../../../src/adapters/git/claim-lock.ts";
import { BunGitCommandExecutor } from "../../../src/adapters/git/workspace.ts";
import { run as runCli } from "../../../src/main.ts";
import { normalizeClaimHome } from "../../../src/domain/claim/home.ts";
import {
  actorRefSchema,
  adapterRefSchema,
  claimRefSchema,
  laneRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../../../src/domain/refs/identifiers.ts";
import { createLane } from "../../../src/domain/lane/lifecycle.ts";
import { StateStore } from "../../../src/persistence/state.ts";
import { saveAttachedLane } from "../../fixtures/lane/attached.ts";
import { GIT_TEST_TIMEOUT_MS } from "../../fixtures/git/remote.ts";

const ticket = ticketRefSchema.parse("jira:x:JWB:ticket:JWB-877");
const runRef = runRefSchema.parse("interlock-run:attach");
const claimRef = claimRefSchema.parse("interlock-claim:attach");
const owner = actorRefSchema.parse("jira:x:user:owner");
const branch = "task/JWB-877";
const now = "2026-01-01T00:00:00.000Z";
const directories: string[] = [];

setDefaultTimeout(GIT_TEST_TIMEOUT_MS);

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function git(argv: string[], cwd: string) {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...argv], {
    cwd,
  });
  if (result.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function claimedRun(options: { lock?: "held" | "absent" | "other" | "owner" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "interlock-attach-"));
  directories.push(root);
  const origin = join(root, "origin.git");
  const main = join(root, "main");
  const worktree = join(root, "worktrees", "JWB-877");
  git(["init", "--quiet", "--bare", "-b", "main", origin], root);
  git(["clone", "--quiet", origin, main], root);
  writeFileSync(join(main, "README"), "base\n");
  git(["add", "README"], main);
  git(["commit", "--quiet", "-m", "base"], main);
  git(["push", "--quiet", "origin", "main"], main);
  mkdirSync(join(root, "worktrees"));
  git(["worktree", "add", "--quiet", "-b", branch, worktree, "main"], main);
  const statePath = join(root, "interlock.db");
  const home = normalizeClaimHome(origin);
  const store = new StateStore(statePath);
  store.saveRun({
    ref: runRef,
    ticket,
    host: adapterRefSchema.parse("t3"),
    harness: adapterRefSchema.parse("t3"),
    workspace: { path: worktree, branch },
    capabilities: {},
    status: "claimed",
    createdAt: now,
    updatedAt: now,
  });
  store.saveClaim({
    ref: claimRef,
    ticket,
    run: runRef,
    humanOwner: owner,
    previousState: { version: "1", payload: null },
    claimedAt: now,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    status: "active",
    claimHome: home.identity,
    claimHomeUrl: home.url,
  });
  store.close();
  const lock = options.lock ?? "held";
  if (lock !== "absent") {
    const claimLock = new GitClaimLock({
      repository: main,
      home,
      git: new BunGitCommandExecutor(),
    });
    await claimLock.claim({
      claim: lock === "held" ? claimRef : claimRefSchema.parse("interlock-claim:someone-else"),
      run: runRef,
      ticket,
      owner: lock === "owner" ? actorRefSchema.parse("jira:x:user:intruder") : owner,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      expectedVersion: (await claimLock.read(ticket)).version,
    });
  }
  const attach = async (cwd = worktree, extra: string[] = []) => {
    const output: string[] = [];
    const code = await runCli(
      ["lane", "attach", "--ticket", ticket, "--state", statePath, "--json", ...extra],
      (text) => output.push(text),
      { statePath, configuration: { cwd } },
    );
    return { code, result: JSON.parse(output.join("\n")) };
  };
  const lanes = () => {
    const reader = new StateStore(statePath);
    try {
      return reader.listLanes();
    } finally {
      reader.close();
    }
  };
  return { root, main, worktree, statePath, attach, lanes };
}

test("attach from the claimed worktree binds one implementing lane to the run and claim", async () => {
  const fixture = await claimedRun();
  const first = await fixture.attach();
  expect(first.code).toBe(0);
  expect(first.result).toMatchObject({
    ok: true,
    value: { ticket, run: runRef, claim: claimRef, state: "implementing" },
  });
  const again = await fixture.attach();
  expect(again.result.value.id).toBe(first.result.value.id);
  expect(fixture.lanes()).toHaveLength(1);
});

test("attach adopts the unattached lane pickup created for the ticket", async () => {
  const fixture = await claimedRun();
  const store = new StateStore(fixture.statePath);
  const pending = createLane(
    { id: laneRefSchema.parse("interlock-lane:pickup"), ticket: ticketRefSchema.parse(ticket) },
    new Date().toISOString(),
  );
  store.saveLane(pending);
  store.close();
  const { result } = await fixture.attach();
  expect(result).toMatchObject({
    ok: true,
    value: { id: pending.id, run: runRef, claim: claimRef, state: "implementing" },
  });
  expect(fixture.lanes()).toHaveLength(1);
});

test("attach from another checkout refuses and records no lane", async () => {
  const fixture = await claimedRun();
  const { code, result } = await fixture.attach(fixture.main);
  expect(code).toBe(1);
  expect(result.refusal.code).toBe("workspace_unknown");
  expect(fixture.lanes()).toHaveLength(0);
});

test("attach from a subdirectory of the worktree refuses", async () => {
  const fixture = await claimedRun();
  mkdirSync(join(fixture.worktree, "src"));
  const { result } = await fixture.attach(join(fixture.worktree, "src"));
  expect(result.refusal.code).toBe("workspace_unknown");
});

test("attach on a different branch refuses before any lane exists", async () => {
  const fixture = await claimedRun();
  git(["switch", "--quiet", "-c", "task/other"], fixture.worktree);
  const { result } = await fixture.attach();
  expect(result.refusal).toMatchObject({ code: "workspace_unknown" });
  expect(result.refusal.message).toContain("task/other");
  expect(fixture.lanes()).toHaveLength(0);
});

test("attach on a detached HEAD refuses", async () => {
  const fixture = await claimedRun();
  git(["switch", "--quiet", "--detach"], fixture.worktree);
  expect((await fixture.attach()).result.refusal.code).toBe("workspace_unknown");
});

test("attach refuses when the remote claim is absent, another claim's, or another owner's", async () => {
  for (const lock of ["absent", "other", "owner"] as const) {
    const fixture = await claimedRun({ lock });
    const { result } = await fixture.attach();
    expect(result.refusal.code).toBe("claim_collision");
    expect(fixture.lanes()).toHaveLength(0);
  }
});

test("attach refuses without exactly one claimed run with an active claim", async () => {
  const fixture = await claimedRun();
  const store = new StateStore(fixture.statePath);
  store.saveClaim({ ...store.claim(claimRef), status: "released" });
  store.close();
  expect((await fixture.attach()).result.refusal.code).toBe("claim_collision");

  const none = await claimedRun();
  const other = new StateStore(none.statePath);
  other.saveRun({ ...other.run(runRef), status: "released" });
  other.close();
  expect((await none.attach()).result.refusal.code).toBe("gates_unmet");

  const two = await claimedRun();
  const both = new StateStore(two.statePath);
  both.saveRun({ ...both.run(runRef), ref: runRefSchema.parse("interlock-run:second") });
  both.close();
  expect((await two.attach()).result.refusal.code).toBe("claim_collision");
});

test("an active lane bound to another run refuses attach", async () => {
  const fixture = await claimedRun();
  const store = new StateStore(fixture.statePath);
  saveAttachedLane(store, {
    ticket: ticketRefSchema.parse(ticket),
    run: runRefSchema.parse("interlock-run:old"),
    claim: claimRefSchema.parse("interlock-claim:old"),
  });
  store.close();
  const { result } = await fixture.attach();
  expect(result.refusal.code).toBe("claim_collision");
});
