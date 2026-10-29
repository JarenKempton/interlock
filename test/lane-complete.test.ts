import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunGitCommandExecutor, type GitCommandExecutor } from "../src/adapters/workspaces/git.ts";
import { run as runCli } from "../src/cli.ts";
import { AmbiguousTrackerResultError } from "../src/domain/contracts.ts";
import {
  actorRefSchema,
  adapterRefSchema,
  claimRefSchema,
  laneRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../src/domain/identifiers.ts";
import type { Ticket, TicketRef } from "../src/domain/model.ts";
import type { MergeProof } from "../src/domain/retirement.ts";
import { LaneService, type LaneTrackerPort } from "../src/execution/lane.ts";
import { StateStore } from "../src/persistence/state.ts";

const ticketRef = ticketRefSchema.parse("jira:x:JWB:ticket:JWB-909");
const runRef = runRefSchema.parse("interlock-run:complete");
const branch = "task/JWB-909";
const prUrl = "https://github.com/o/r/pull/9";
const now = "2026-01-01T00:00:00.000Z";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function git(argv: string[], cwd: string) {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...argv], {
    cwd,
  });
  if (result.exitCode !== 0) throw new Error(`git ${argv.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
}

function repository(options: { merged: boolean; squash?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "interlock-complete-"));
  directories.push(root);
  const origin = join(root, "origin.git");
  const main = join(root, "main");
  const lane = join(root, "worktrees", "JWB-909");
  git(["init", "--quiet", "--bare", "-b", "main", origin], root);
  git(["clone", "--quiet", origin, main], root);
  git(["config", `url.${origin}.insteadOf`, "https://github.com/o/r.git"], main);
  git(["remote", "set-url", "origin", "https://github.com/o/r.git"], main);
  writeFileSync(join(main, "README"), "base\n");
  git(["add", "README"], main);
  git(["commit", "--quiet", "-m", "base"], main);
  git(["push", "--quiet", "origin", "main"], main);
  mkdirSync(join(root, "worktrees"));
  git(["worktree", "add", "--quiet", "-b", branch, lane, "main"], main);
  writeFileSync(join(lane, "change"), "work\n");
  git(["add", "change"], lane);
  git(["commit", "--quiet", "-m", "work"], lane);
  const head = git(["rev-parse", "HEAD"], lane);
  const originalMain = git(["rev-parse", "HEAD"], main);
  if (options.merged) {
    if (options.squash) {
      git(["merge", "--quiet", "--squash", branch], main);
      git(["commit", "--quiet", "-m", "squash"], main);
    } else git(["merge", "--quiet", "--no-ff", "-m", "merge", branch], main);
    git(["push", "--quiet", "origin", "main"], main);
  }
  const merge = git(["rev-parse", "HEAD"], main);
  git(["reset", "--hard", originalMain], main);
  return { root, main, lane, head, merge, originalMain, origin };
}

class FakeJira implements LaneTrackerPort {
  ticket: Ticket = {
    ref: ticketRef,
    map: mapRefSchema.parse("jira:x:JWB:map:JWB-556"),
    kind: "task",
    state: "open",
    status: "In Progress",
    order: 0,
  };
  transitions: string[] = [];
  onTransition: (fake: FakeJira) => void = (fake) => fake.set("Done");

  set(status: string) {
    this.ticket = { ...this.ticket, status, state: status === "Done" ? "closed" : "open" };
  }

  async read() {
    return { ticket: this.ticket, snapshot: { version: "1", payload: null } };
  }

  async transition(_ticket: TicketRef, status: string) {
    this.transitions.push(status);
    this.onTransition(this);
  }
}

async function mergedLane(
  options: {
    merged?: boolean;
    prMerged?: boolean;
    tracker?: FakeJira;
    squash?: boolean;
    git?: GitCommandExecutor;
  } = {},
) {
  const repo = repository({ merged: options.merged ?? true, squash: options.squash ?? false });
  const statePath = join(repo.root, "interlock.db");
  const store = new StateStore(statePath);
  store.saveRun({
    ref: runRef,
    ticket: ticketRef,
    harness: adapterRefSchema.parse("t3"),
    workspace: { path: repo.lane, branch },
    capabilities: {},
    status: "claimed",
    createdAt: now,
    updatedAt: now,
  });
  store.saveClaim({
    ref: claimRefSchema.parse("interlock-claim:complete"),
    ticket: ticketRef,
    run: runRef,
    humanOwner: actorRefSchema.parse("owner"),
    previousState: { version: "1", payload: null },
    claimedAt: now,
    leaseExpiresAt: "2099-01-01T00:00:00Z",
    status: "active",
  });
  const service = new LaneService({
    store,
    newId: () => laneRefSchema.parse("interlock-lane:complete"),
  });
  const created = service.create({ ticket: String(ticketRef) });
  if (!created.ok) throw new Error(created.refusal.message);
  const evidence = [{ gate: "test", head: repo.head, url: "https://ci.test/abc" }];
  for (const command of [
    { type: "claim", run: runRef, claim: "interlock-claim:complete" },
    { type: "start" },
    { type: "submit", artifact: prUrl, head: repo.head, evidence },
    { type: "begin_review" },
    { type: "verdict", head: repo.head, decision: "approved", findings: [] },
    { type: "merge", head: repo.head },
  ] as const) {
    const result = await service.apply(created.value.id, command);
    if (!result.ok) throw new Error(result.refusal.message);
  }
  store.close();
  const tracker = options.tracker ?? new FakeJira();
  const views: string[] = [];
  const proof: MergeProof = {
    merged: options.prMerged ?? true,
    base: "main",
    url: prUrl,
    repository: "github.com/o/r",
    branch,
    head: repo.head,
    commit: repo.merge,
  };
  const artifacts = {
    prepare: async () => ({
      path: repo.lane,
      branch,
      repository: "github.com/o/r",
      remote: "https://github.com/o/r.git",
      head: repo.head,
    }),
    push: async () => {},
    pullRequests: async () => [],
    open: async () => ({ url: prUrl, branch, state: "OPEN" as const }),
    merged: async (url: string) => {
      views.push(url);
      return proof;
    },
  };
  const complete = async () => {
    const output: string[] = [];
    const code = await runCli(
      ["lane", "complete", created.value.id, "--state", statePath, "--json"],
      (text) => output.push(text),
      {
        statePath,
        lane: { tracker, artifacts },
        ...(options.git ? { execution: { git: options.git } } : {}),
      },
    );
    return { code, result: JSON.parse(output.join("\n")) };
  };
  const intact = () => {
    expect(existsSync(repo.lane)).toBe(true);
    expect(git(["branch", "--list", branch], repo.main)).toContain(branch);
  };
  return { repo, tracker, views, complete, intact, id: created.value.id, statePath, proof };
}

test("complete moves the ticket to Done, verifies it, removes the merged worktree and branch, and closes the lane", async () => {
  const lane = await mergedLane();
  const { code, result } = await lane.complete();
  expect(code).toBe(0);
  expect(result).toMatchObject({ ok: true, value: { state: "done" } });
  expect(lane.tracker.transitions).toEqual(["Done"]);
  expect(lane.views).toEqual([prUrl]);
  expect(existsSync(lane.repo.lane)).toBe(false);
  expect(git(["branch", "--list", branch], lane.repo.main)).toBe("");
  expect(existsSync(join(lane.repo.main, "README"))).toBe(true);
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "invalid_transition" },
  });
});

test("complete skips the tracker write when the ticket is already Done", async () => {
  const tracker = new FakeJira();
  tracker.set("Done");
  const lane = await mergedLane({ tracker });
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
  expect(tracker.transitions).toEqual([]);
});

test("a Jira transition collision completes only when readback shows Done", async () => {
  const doneElsewhere = new FakeJira();
  doneElsewhere.onTransition = (fake) => {
    fake.set("Done");
    throw new Error("Jira has no transition to Done");
  };
  const won = await mergedLane({ tracker: doneElsewhere });
  expect((await won.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });

  const movedElsewhere = new FakeJira();
  movedElsewhere.onTransition = (fake) => {
    fake.set("In Review");
    throw new Error("Jira has no transition to Done");
  };
  const lost = await mergedLane({ tracker: movedElsewhere });
  const { code, result } = await lost.complete();
  expect(code).toBe(1);
  expect(result).toMatchObject({ ok: false, refusal: { code: "tracker_write_failed" } });
  lost.intact();
});

test("a readback mismatch after the Done transition refuses and removes nothing", async () => {
  const tracker = new FakeJira();
  tracker.onTransition = () => {};
  const lane = await mergedLane({ tracker });
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "tracker_not_done" },
  });
  lane.intact();
});

test("an ambiguous Done transition refuses and removes nothing", async () => {
  const tracker = new FakeJira();
  tracker.onTransition = () => {
    throw new AmbiguousTrackerResultError("Jira transition was not verified");
  };
  const lane = await mergedLane({ tracker });
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "ambiguous_write" },
  });
  lane.intact();
});

test("a dirty worktree refuses, names what is left, and removes nothing", async () => {
  const lane = await mergedLane();
  writeFileSync(join(lane.repo.lane, "scratch"), "uncommitted\n");
  const { code, result } = await lane.complete();
  expect(code).toBe(1);
  expect(result).toMatchObject({ ok: false, refusal: { code: "workspace_dirty" } });
  expect(result.refusal.message).toContain(realpathSync.native(lane.repo.lane));
  expect(result.refusal.message).toContain(branch);
  lane.intact();
});

test("an unmerged branch refuses, names what is left, and removes nothing", async () => {
  const lane = await mergedLane({ merged: false });
  const { result } = await lane.complete();
  expect(result).toMatchObject({ ok: false, refusal: { code: "branch_unmerged" } });
  expect(result.refusal.message).toContain(branch);
  lane.intact();
});

test("an unmerged pull request refuses before any tracker write and removes nothing", async () => {
  const lane = await mergedLane({ prMerged: false });
  const { result } = await lane.complete();
  expect(result).toMatchObject({ ok: false, refusal: { code: "pull_request_unmerged" } });
  expect(lane.tracker.transitions).toEqual([]);
  lane.intact();
});

test("a lane stopped in attention refuses completion and removes nothing", async () => {
  const lane = await mergedLane();
  const output: string[] = [];
  await runCli(
    ["lane", "attention", lane.id, "--reason", "stopped", "--state", lane.statePath, "--json"],
    (text) => output.push(text),
    { statePath: lane.statePath },
  );
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "invalid_transition" },
  });
  expect(lane.tracker.transitions).toEqual([]);
  lane.intact();
});

function changeStore(
  lane: Awaited<ReturnType<typeof mergedLane>>,
  change: (store: StateStore) => void,
) {
  const store = new StateStore(lane.statePath);
  try {
    change(store);
  } finally {
    store.close();
  }
}

test("squash integration is verified without moving the stale main checkout and retains the original head", async () => {
  const lane = await mergedLane({ squash: true });
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
  expect(git(["rev-parse", "HEAD"], lane.repo.main)).toBe(lane.repo.originalMain);
  changeStore(lane, (store) => {
    const record = store.retirement(lane.id);
    if (!record) throw new Error("Missing retirement record");
    expect(record.phase).toBe("branch_removed");
    expect(record.plan.integration).toBe("squash");
    expect(git(["rev-parse", record.plan.retainedRef], lane.repo.main)).toBe(lane.repo.head);
  });
});

for (const status of [
  "planning",
  "compensated",
  "collision",
  "released",
  "recovery_required",
] as const) {
  test(`run ${status} refuses cleanup before Jira writes`, async () => {
    const lane = await mergedLane();
    changeStore(lane, (store) => store.saveRun({ ...store.run(runRef), status }));
    expect((await lane.complete()).result).toMatchObject({
      ok: false,
      refusal: { code: "workspace_unknown" },
    });
    expect(lane.tracker.transitions).toEqual([]);
    lane.intact();
  });
}

test("shared run in another lane refuses destruction regardless of that lane's state", async () => {
  const lane = await mergedLane();
  changeStore(lane, (store) => {
    const other = {
      ...store.lane(lane.id),
      id: laneRefSchema.parse("interlock-lane:other"),
      claim: claimRefSchema.parse("interlock-claim:other"),
    };
    store.saveLane(other);
  });
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "workspace_unknown" },
  });
  expect(lane.tracker.transitions).toEqual([]);
  lane.intact();
});

test("a different run targeting another lane's path also refuses", async () => {
  const lane = await mergedLane();
  changeStore(lane, (store) => {
    const otherRun = runRefSchema.parse("interlock-run:other");
    store.saveRun({ ...store.run(runRef), ref: otherRun });
    store.saveLane({
      ...store.lane(lane.id),
      id: laneRefSchema.parse("interlock-lane:other"),
      run: otherRun,
      claim: claimRefSchema.parse("interlock-claim:other"),
    });
  });
  expect((await lane.complete()).result.ok).toBe(false);
  lane.intact();
});

test("released or wrong-ticket claim cannot authorize retirement", async () => {
  for (const mode of ["released", "wrong-ticket"] as const) {
    const lane = await mergedLane();
    changeStore(lane, (store) => {
      const claim = store.claim(claimRefSchema.parse("interlock-claim:complete"));
      if (mode === "released") store.saveClaim({ ...claim, status: "released" });
      else
        store.saveLane({
          ...store.lane(lane.id),
          ticket: ticketRefSchema.parse("jira:x:JWB:ticket:JWB-1"),
        });
    });
    expect((await lane.complete()).result.ok).toBe(false);
    expect(lane.tracker.transitions).toEqual([]);
    lane.intact();
  }
});

for (const field of ["head", "branch", "repository", "commit"] as const) {
  test(`mismatched host ${field} does not authorize removal`, async () => {
    const lane = await mergedLane();
    lane.proof[field] = field === "head" || field === "commit" ? "f".repeat(40) : "wrong";
    expect((await lane.complete()).result.ok).toBe(false);
    expect(lane.tracker.transitions).toEqual([]);
    lane.intact();
  });
}

test("main checkout is never retired", async () => {
  const lane = await mergedLane();
  changeStore(lane, (store) =>
    store.saveRun({ ...store.run(runRef), workspace: { path: lane.repo.main, branch: "main" } }),
  );
  lane.proof.branch = "main";
  expect((await lane.complete()).result.ok).toBe(false);
  expect(existsSync(join(lane.repo.main, "README"))).toBe(true);
});

test("ignored files refuse as dirty before tracker mutation", async () => {
  const lane = await mergedLane();
  const info = git(["rev-parse", "--git-path", "info/exclude"], lane.repo.main);
  writeFileSync(join(lane.repo.main, info), "scratch\n");
  writeFileSync(join(lane.repo.lane, "scratch"), "keep me");
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "workspace_dirty" },
  });
  expect(lane.tracker.transitions).toEqual([]);
  lane.intact();
});

for (const operation of ["worktree", "branch"] as const) {
  test(`lost response after ${operation} removal resumes from durable intent`, async () => {
    const gitExecutor = new BunGitCommandExecutor();
    let interrupted = false;
    const lane = await mergedLane({
      git: {
        async run(argv, cwd) {
          const result = await gitExecutor.run(argv, cwd);
          const removing =
            operation === "worktree"
              ? argv[1] === "worktree" && argv[2] === "remove"
              : argv.includes("-d");
          if (removing && result.exitCode === 0 && !interrupted) {
            interrupted = true;
            throw new Error(`crash after ${operation} removal`);
          }
          return result;
        },
      },
    });
    expect((await lane.complete()).result).toMatchObject({
      ok: false,
      refusal: { code: "cleanup_pending" },
    });
    expect(existsSync(lane.repo.lane)).toBe(false);
    expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
    changeStore(lane, (store) => expect(store.retirement(lane.id)?.phase).toBe("branch_removed"));
  });
}

test("a real ref lock failure after worktree removal can resume after lock release", async () => {
  const lane = await mergedLane();
  const ref = git(["rev-parse", "--git-path", `refs/heads/${branch}`], lane.repo.main);
  const lock = join(lane.repo.main, `${ref}.lock`);
  writeFileSync(lock, "");
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "cleanup_pending" },
  });
  expect(existsSync(lane.repo.lane)).toBe(false);
  rmSync(lock);
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
});

test("changed retained ref and recreated branch both refuse on retry", async () => {
  const executor = new BunGitCommandExecutor();
  const lane = await mergedLane({
    git: {
      async run(argv, cwd) {
        if (argv.includes("-d")) throw new Error("pause before branch removal");
        return executor.run(argv, cwd);
      },
    },
  });
  expect((await lane.complete()).result.ok).toBe(false);
  changeStore(lane, (store) => {
    const record = store.retirement(lane.id);
    if (!record) throw new Error("Missing retirement record");
    git(["update-ref", record.plan.retainedRef, lane.repo.originalMain], lane.repo.main);
  });
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "cleanup_pending" },
  });
  expect(git(["rev-parse", branch], lane.repo.main)).toBe(lane.repo.head);
});

test("base rewritten behind the host merge refuses without deleting anything", async () => {
  const lane = await mergedLane();
  git(["update-ref", "refs/heads/main", lane.repo.originalMain], lane.repo.origin);
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "branch_unmerged" },
  });
  lane.intact();
});

test("an unrelated same-tree root commit cannot masquerade as a squash merge", async () => {
  const lane = await mergedLane({ squash: true });
  const tree = git(["rev-parse", `${lane.repo.merge}^{tree}`], lane.repo.main);
  const unrelated = git(["commit-tree", tree, "-m", "unrelated root"], lane.repo.main);
  git(["push", "origin", `${unrelated}:refs/heads/unrelated`], lane.repo.main);
  lane.proof.commit = unrelated;
  lane.proof.base = "unrelated";
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "branch_unmerged" },
  });
  lane.intact();
});

test("mismatched Jira readback does not retire the lane", async () => {
  const tracker = new FakeJira();
  tracker.ticket = {
    ...tracker.ticket,
    ref: ticketRefSchema.parse("jira:x:JWB:ticket:JWB-1"),
    status: "Done",
    state: "closed",
  };
  const lane = await mergedLane({ tracker });
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "tracker_not_done" },
  });
  lane.intact();
});

test("ambiguous transition that is verified Done by readback can complete", async () => {
  const tracker = new FakeJira();
  tracker.onTransition = (fake) => {
    fake.set("Done");
    throw new AmbiguousTrackerResultError("lost response");
  };
  const lane = await mergedLane({ tracker });
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
});
