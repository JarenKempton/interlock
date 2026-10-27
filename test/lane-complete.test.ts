import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runCli } from "../src/cli.ts";
import { AmbiguousTrackerResultError } from "../src/domain/contracts.ts";
import {
  adapterRefSchema,
  laneRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../src/domain/identifiers.ts";
import type { Ticket, TicketRef } from "../src/domain/model.ts";
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

function repository(options: { merged: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "interlock-complete-"));
  directories.push(root);
  const origin = join(root, "origin.git");
  const main = join(root, "main");
  const lane = join(root, "worktrees", "JWB-909");
  git(["init", "--quiet", "--bare", "-b", "main", origin], root);
  git(["clone", "--quiet", origin, main], root);
  git(["config", `url.${origin}.insteadOf`, "https://example.test/o/r.git"], main);
  git(["remote", "set-url", "origin", "https://example.test/o/r.git"], main);
  writeFileSync(join(main, "README"), "base\n");
  git(["add", "README"], main);
  git(["commit", "--quiet", "-m", "base"], main);
  git(["push", "--quiet", "origin", "main"], main);
  mkdirSync(join(root, "worktrees"));
  git(["worktree", "add", "--quiet", "-b", branch, lane, "main"], main);
  writeFileSync(join(lane, "change"), "work\n");
  git(["add", "change"], lane);
  git(["commit", "--quiet", "-m", "work"], lane);
  if (options.merged) {
    git(["merge", "--quiet", "--no-ff", "-m", "merge", branch], main);
    git(["push", "--quiet", "origin", "main"], main);
  }
  return { root, main, lane };
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
  options: { merged?: boolean; prMerged?: boolean; tracker?: FakeJira } = {},
) {
  const repo = repository({ merged: options.merged ?? true });
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
  const service = new LaneService({
    store,
    newId: () => laneRefSchema.parse("interlock-lane:complete"),
  });
  const created = service.create({ ticket: String(ticketRef) });
  if (!created.ok) throw new Error(created.refusal.message);
  const evidence = [{ gate: "test", head: "abc", url: "https://ci.test/abc" }];
  for (const command of [
    { type: "claim", run: runRef, claim: "interlock-claim:complete" },
    { type: "start" },
    { type: "submit", artifact: prUrl, head: "abc", evidence },
    { type: "begin_review" },
    { type: "verdict", head: "abc", decision: "approved", findings: [] },
    { type: "merge", head: "abc" },
  ] as const) {
    const result = await service.apply(created.value.id, command);
    if (!result.ok) throw new Error(result.refusal.message);
  }
  store.close();
  const tracker = options.tracker ?? new FakeJira();
  const views: string[] = [];
  const artifacts = {
    push: async () => {},
    pullRequests: async () => [],
    open: async () => ({ url: prUrl, branch }),
    merged: async (url: string) => {
      views.push(url);
      return { merged: options.prMerged ?? true, base: "main" };
    },
  };
  const complete = async () => {
    const output: string[] = [];
    const code = await runCli(
      ["lane", "complete", created.value.id, "--state", statePath, "--json"],
      (text) => output.push(text),
      { statePath, lane: { tracker, artifacts } },
    );
    return { code, result: JSON.parse(output.join("\n")) };
  };
  const intact = () => {
    expect(existsSync(repo.lane)).toBe(true);
    expect(git(["branch", "--list", branch], repo.main)).toContain(branch);
  };
  return { repo, tracker, views, complete, intact, id: created.value.id, statePath };
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
  expect(result.refusal.message).toContain(lane.repo.lane);
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
