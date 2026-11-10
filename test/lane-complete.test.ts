import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { BunGitCommandExecutor } from "../src/adapters/workspaces/git.ts";
import { GIT_TEST_TIMEOUT_MS } from "./fixtures/git-remote.ts";
import {
  FakeJira,
  laneCompleteFixtures,
  prUrl,
  runRef,
  ticketRef,
} from "./fixtures/lane-complete.ts";

setDefaultTimeout(GIT_TEST_TIMEOUT_MS);
const { mergedLane, changeStore } = laneCompleteFixtures();

for (const state of ["approved", "merged"] as const) {
  test(`complete --ticket finishes ${state}, preserves the workspace and returns identical success on retry`, async () => {
    const lane = await mergedLane({ state });
    const first = await lane.complete();
    expect(first.code).toBe(0);
    expect(first.result).toMatchObject({ ok: true, value: { state: "done" } });
    expect(lane.tracker.transitions).toEqual(["Done"]);
    lane.intact();
    expect(await lane.complete()).toEqual(first);
    expect(lane.views).toEqual([prUrl]);
    expect(lane.tracker.transitions).toEqual(["Done"]);
  });
}

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

for (const status of [
  "planning",
  "compensated",
  "collision",
  "released",
  "recovery_required",
] as const) {
  test(`run ${status} refuses completion before Jira writes`, async () => {
    const lane = await mergedLane();
    changeStore(lane, (store) => store.saveRun({ ...store.run(runRef), status }));
    expect((await lane.complete()).result).toMatchObject({
      ok: false,
      refusal: { code: "claim_collision" },
    });
    expect(lane.tracker.transitions).toEqual([]);
    lane.intact();
  });
}

test("shared run in another lane refuses completion regardless of that lane's state", async () => {
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
    refusal: { code: "claim_collision" },
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

test("an unreadable claim lock refuses as transient, leaves the run claimed, and a retry completes", async () => {
  let failed = false;
  const git = new BunGitCommandExecutor();
  const lane = await mergedLane({
    git: {
      run: async (argv, cwd) => {
        if (!failed && argv[1] === "ls-remote" && argv[2] !== "--get-url") {
          failed = true;
          return { exitCode: 128, stdout: "", stderr: "Could not resolve host: github.com" };
        }
        return git.run(argv, cwd);
      },
    },
  });

  const refused = await lane.complete();
  expect(refused.result).toMatchObject({ ok: false, refusal: { code: "tracker_unavailable" } });
  changeStore(lane, (store) => expect(store.run(runRef).status).toBe("claimed"));
  expect(lane.tracker.transitions).toEqual([]);

  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
  expect(lane.tracker.transitions).toEqual(["Done"]);
});

test("a merged head that only adds a clean merge from main completes on the approved head", async () => {
  const lane = await mergedLane({ afterApproval: "base_merge" });
  expect(lane.repo.prHead).not.toBe(lane.repo.head);
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
  expect(lane.tracker.transitions).toEqual(["Done"]);
});

for (const afterApproval of ["commit", "edited_merge"] as const)
  test(`a merged head with unreviewed changes after approval still refuses: ${afterApproval}`, async () => {
    const lane = await mergedLane({ afterApproval });
    expect((await lane.complete()).result).toMatchObject({
      ok: false,
      refusal: { code: "stale_evidence" },
    });
    expect(lane.tracker.transitions).toEqual([]);
    lane.intact();
  });

test("released or wrong-ticket claim cannot authorize completion", async () => {
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

for (const field of ["head", "branch", "url"] as const) {
  test(`mismatched host ${field} does not authorize completion`, async () => {
    const lane = await mergedLane();
    lane.proof[field] = field === "head" ? "f".repeat(40) : "wrong";
    expect((await lane.complete()).result.ok).toBe(false);
    expect(lane.tracker.transitions).toEqual([]);
    lane.intact();
  });
}

test("mismatched Jira readback does not complete the lane", async () => {
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

test("a ticket with an earlier done lane requires an explicit lane reference", async () => {
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
      createdAt: "2020-01-01T00:00:00Z",
    });
  });
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "claim_collision" },
  });
  const completed = await lane.complete({ lane: lane.id });
  expect(completed.result).toMatchObject({ ok: true, value: { state: "done", id: lane.id } });
  expect(await lane.complete({ lane: lane.id })).toEqual(completed);
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
  expect(existsSync(lane.repo.lane)).toBe(true);
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

test("completion adopts a missing PR by the recorded head branch", async () => {
  const lane = await mergedLane();
  changeStore(lane, (store) => {
    const saved = store.lane(lane.id);
    delete saved.artifact;
    store.saveLane(saved);
  });
  expect((await lane.complete()).result).toMatchObject({
    ok: true,
    value: { artifact: prUrl, state: "done" },
  });
});

test("dirty and ignored workspace contents are untouched by completion", async () => {
  const lane = await mergedLane();
  writeFileSync(join(lane.repo.lane, "scratch"), "uncommitted");
  expect((await lane.complete()).code).toBe(0);
  expect(readFileSync(join(lane.repo.lane, "scratch"), "utf8")).toBe("uncommitted");
  lane.intact();
});

test("interrupted tracker readback resumes the journal without repeating an accepted transition", async () => {
  const tracker = new FakeJira();
  tracker.onTransition = (fake) => {
    fake.set("Done");
    fake.failing.add(ticketRef);
    throw new AmbiguousTrackerResultError("lost response");
  };
  const lane = await mergedLane({ tracker });
  expect((await lane.complete()).result.ok).toBe(false);
  changeStore(lane, (store) => {
    expect(store.lane(lane.id).state).toBe("approved");
    expect(store.steps(runRef).map((step) => step.state)).toContain("lane_completion_pending");
  });
  tracker.failing.clear();
  const completed = await lane.complete();
  expect(completed.code).toBe(0);
  expect(tracker.transitions).toEqual(["Done"]);
  expect(await lane.complete()).toEqual(completed);
});

test("changed merge proof on recovery refuses without another tracker write", async () => {
  const tracker = new FakeJira();
  tracker.onTransition = () => {};
  const lane = await mergedLane({ tracker });
  expect((await lane.complete()).result.ok).toBe(false);
  lane.proof.commit = "f".repeat(40);
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "recovery_required" },
  });
  expect(tracker.transitions).toEqual(["Done"]);
});

test("ticket selectors reject missing, conflicting and ambiguous identities before mutation", async () => {
  const lane = await mergedLane();
  expect((await lane.complete({})).result).toMatchObject({
    ok: false,
    refusal: { code: "gates_unmet" },
  });
  expect((await lane.complete({ lane: lane.id, ticket: "JWB-909" })).result).toMatchObject({
    ok: false,
    refusal: { code: "gates_unmet" },
  });
  expect((await lane.complete({ ticket: "JWB-999" })).result).toMatchObject({
    ok: false,
    refusal: { code: "lane_not_found" },
  });
  changeStore(lane, (store) =>
    store.saveLane({
      ...store.lane(lane.id),
      id: laneRefSchema.parse("interlock-lane:other-site"),
      ticket: ticketRefSchema.parse("jira:other:JWB:ticket:JWB-909"),
      state: "done",
    }),
  );
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "claim_collision" },
  });
  expect(lane.tracker.transitions).toEqual([]);
});

test("missing or ambiguous branch PRs refuse adoption before tracker writes", async () => {
  const lane = await mergedLane();
  changeStore(lane, (store) => {
    const saved = store.lane(lane.id);
    delete saved.artifact;
    store.saveLane(saved);
  });
  lane.artifacts.pullRequests = async () => [];
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "artifact_required" },
  });
  lane.artifacts.pullRequests = async () =>
    [1, 2].map((number) => ({
      url: `https://github.com/o/r/pull/${number}`,
      branch: lane.proof.branch,
      state: "MERGED",
    }));
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "artifact_required" },
  });
  expect(lane.tracker.transitions).toEqual([]);
});
