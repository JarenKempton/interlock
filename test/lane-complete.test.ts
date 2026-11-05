import { expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunGitCommandExecutor } from "../src/adapters/workspaces/git.ts";
import { run as runCli } from "../src/cli.ts";
import { resolveConfiguration } from "../src/configuration/schema.ts";
import { AmbiguousTrackerResultError } from "../src/domain/contracts.ts";
import {
  actorRefSchema,
  claimRefSchema,
  laneRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../src/domain/identifiers.ts";
import type { Ticket, TicketRef } from "../src/domain/model.ts";
import { StateStore } from "../src/persistence/state.ts";
import { GIT_TEST_TIMEOUT_MS } from "./fixtures/git-remote.ts";
import {
  branch,
  FakeJira,
  git,
  laneCompleteFixtures,
  prUrl,
  runRef,
  ticketRef,
} from "./fixtures/lane-complete.ts";

setDefaultTimeout(GIT_TEST_TIMEOUT_MS);
const { mergedLane, directories, changeStore } = laneCompleteFixtures();

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

test("ignored files such as installed dependencies are preserved, not refused", async () => {
  const lane = await mergedLane();
  const info = git(["rev-parse", "--git-path", "info/exclude"], lane.repo.main);
  writeFileSync(join(lane.repo.main, info), "node_modules/\n");
  mkdirSync(join(lane.repo.lane, "node_modules"));
  writeFileSync(join(lane.repo.lane, "node_modules", "dep.js"), "keep me");
  const { result } = await lane.complete();
  expect(result).toMatchObject({ ok: true, value: { state: "done" } });
  expect(
    readFileSync(join(result.retirement.preservedFiles, "node_modules", "dep.js"), "utf8"),
  ).toBe("keep me");
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

test("a later lane for the same ticket can retire after the first lane is done", () => {
  const root = mkdtempSync(join(tmpdir(), "interlock-retire-again-"));
  directories.push(root);
  const store = new StateStore(join(root, "interlock.db"));
  try {
    const plan = (lane: string, run: string) => ({
      lane: laneRefSchema.parse(lane),
      run: runRefSchema.parse(run),
      claim: claimRefSchema.parse(`interlock-claim:${run.split(":")[1]}`),
      ticket: ticketRef,
      path: "/w/JWB-909",
      branch,
      head: "a".repeat(40),
      artifact: prUrl,
      worktreePath: "/w/JWB-909",
      repositoryPath: "/r",
      commonDirectory: "/r/.git",
      worktreeDirectory: "/r/.git/worktrees/JWB-909",
      worktreeIdentity: "1:2:3",
      proof: {
        merged: true,
        url: prUrl,
        repository: "github.com/o/r",
        branch,
        head: "a".repeat(40),
        base: "main",
        commit: "b".repeat(40),
      },
      retainedRef: `refs/interlock/retired/${lane.length}`,
      integration: "ancestry" as const,
    });
    store.beginRetirement(plan("interlock-lane:first", "interlock-run:first"));
    store.advanceRetirement(laneRefSchema.parse("interlock-lane:first"), "worktree_removed");
    store.advanceRetirement(laneRefSchema.parse("interlock-lane:first"), "branch_removed");
    expect(
      store.beginRetirement(plan("interlock-lane:second-lane", "interlock-run:second")).phase,
    ).toBe("prepared");
  } finally {
    store.close();
  }
});

test("a done lane that once used the same path does not block completion", async () => {
  const lane = await mergedLane();
  changeStore(lane, (store) => {
    const otherRun = runRefSchema.parse("interlock-run:earlier");
    store.saveRun({ ...store.run(runRef), ref: otherRun, status: "released" });
    store.saveLane({
      ...store.lane(lane.id),
      id: laneRefSchema.parse("interlock-lane:earlier"),
      run: otherRun,
      claim: claimRefSchema.parse("interlock-claim:earlier"),
      state: "done",
    });
  });
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
});

const jwb = (key: string) => ticketRefSchema.parse(`jira:x:JWB:ticket:${key}`);

const blocks = (blocking: TicketRef, blocked: TicketRef) => ({
  blocking,
  blocked,
  kind: "blocks" as const,
});

function dependent(key: string, blockers: TicketRef[], options: Partial<Ticket> = {}): Ticket {
  return {
    ref: jwb(key),
    map: mapRefSchema.parse("jira:x:JWB:map:JWB-556"),
    kind: "task",
    state: "open",
    status: "To Do",
    order: 0,
    dependencies: blockers.map((blocker) => blocks(blocker, jwb(key))),
    ...options,
  };
}

function blockingTracker(otherBlockerClosed: boolean) {
  const tracker = new FakeJira();
  tracker.ticket = {
    ...tracker.ticket,
    dependents: ["JWB-911", "JWB-912", "JWB-913", "JWB-914", "JWB-915"].map((key) =>
      blocks(ticketRef, jwb(key)),
    ),
  };
  tracker.others = [
    dependent("JWB-900", [], otherBlockerClosed ? { state: "closed", status: "Done" } : {}),
    dependent("JWB-911", [ticketRef]),
    dependent("JWB-912", [ticketRef, jwb("JWB-900")]),
    dependent("JWB-913", [ticketRef], { map: mapRefSchema.parse("jira:x:JWB:map:JWB-470") }),
    dependent("JWB-914", [ticketRef], { assignee: actorRefSchema.parse("someone") }),
    dependent("JWB-915", [ticketRef], { status: "In Review" }),
  ];
  return tracker;
}

test("CLI complete reports dependents with every blocker closed that pickup would accept", async () => {
  const tracker = blockingTracker(false);
  const lane = await mergedLane({ tracker, pickedUp: true });
  const { code, result } = await lane.complete();
  expect(code).toBe(0);
  expect(result).toMatchObject({ ok: true, value: { state: "done" } });
  expect(result.unblocked).toEqual({ state: "known", tickets: [jwb("JWB-911")] });
  expect(tracker.transitions).toEqual(["Done"]);
});

test("a run picked up without maps reports dependents in any epic, or none, by pickable status", async () => {
  const tracker = blockingTracker(true);
  const unparented = tracker.others.find((other) => other.ref === jwb("JWB-911"));
  if (unparented) delete unparented.map;
  const lane = await mergedLane({
    tracker,
    pickedUp: true,
    configuration: {
      ...resolveConfiguration(undefined, { jira_site: "https://x.atlassian.net" }),
      repository: {
        name: "r",
        remote: "https://github.com/o/r.git",
        path: "/r",
        worktreeRoot: "/worktrees/r",
        baseBranch: "main",
      },
    },
  });
  expect((await lane.complete()).result.unblocked).toEqual({
    state: "known",
    tickets: [jwb("JWB-911"), jwb("JWB-912"), jwb("JWB-913")],
  });
});

test("CLI complete reports every dependent once all of its blockers are closed", async () => {
  const lane = await mergedLane({ tracker: blockingTracker(true), pickedUp: true });
  expect((await lane.complete()).result.unblocked).toEqual({
    state: "known",
    tickets: [jwb("JWB-911"), jwb("JWB-912")],
  });
});

test("CLI complete reports an empty list for a ticket that blocks nothing", async () => {
  const lane = await mergedLane({ pickedUp: true });
  expect((await lane.complete()).result.unblocked).toEqual({ state: "known", tickets: [] });
});

test("a failed dependent read reports unblocked as unknown and complete still succeeds", async () => {
  const tracker = blockingTracker(true);
  tracker.failing.add(jwb("JWB-900"));
  const lane = await mergedLane({ tracker, pickedUp: true });
  const { code, result } = await lane.complete();
  expect(code).toBe(0);
  expect(result).toMatchObject({
    ok: true,
    value: { state: "done" },
    unblocked: { state: "unknown", reason: expect.stringContaining("503") },
  });
  expect(result.unblocked.tickets).toBeUndefined();
  expect(existsSync(lane.repo.lane)).toBe(false);
});

test("a run without recorded pickup configuration reports unblocked as unknown", async () => {
  const lane = await mergedLane({ tracker: blockingTracker(true) });
  expect((await lane.complete()).result).toMatchObject({
    ok: true,
    unblocked: { state: "unknown", reason: "Run has no recorded pickup configuration" },
  });
});

test("MCP complete returns the same unblocked report", async () => {
  const lane = await mergedLane({ tracker: blockingTracker(false), pickedUp: true, mcp: true });
  expect((await lane.complete()).result.unblocked).toEqual({
    state: "known",
    tickets: [jwb("JWB-911")],
  });
});
