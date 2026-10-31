import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { GitClaimLock } from "../src/adapters/claims/git-lock.ts";
import { GitSubmissionAuthority, submissionRef } from "../src/adapters/submissions/git.ts";
import {
  BunGitCommandExecutor,
  type GitCommandExecutor,
  GitWorkspaceAdapter,
} from "../src/adapters/workspaces/git.ts";
import { createApplication } from "../src/application.ts";
import { run as runCli } from "../src/cli.ts";
import {
  type ExecutionConfiguration,
  resolveConfiguration,
  validateExecutionConfiguration,
} from "../src/configuration/schema.ts";
import { normalizeClaimHome } from "../src/domain/claim-home.ts";
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
import { McpServer } from "../src/mcp/server.ts";
import { StateStore } from "../src/persistence/state.ts";
import { GIT_TEST_TIMEOUT_MS } from "./fixtures/git-remote.ts";

const ticketRef = ticketRefSchema.parse("jira:x:JWB:ticket:JWB-909");
const runRef = runRefSchema.parse("interlock-run:complete");
const branch = "task/JWB-909";
const prUrl = "https://github.com/o/r/pull/9";
const now = "2026-01-01T00:00:00.000Z";
const directories: string[] = [];
const legacyPickupConfiguration = validateExecutionConfiguration({
  version: 1,
  source: { path: "/project/interlock.toml", version: "sha256:fixture" },
  project: {
    version: 1,
    repositories: {
      r: { github: "o/r", path: "main", worktree_root: "worktrees", base_branch: "main" },
    },
    maps: {
      "JWB-556": { repository: "r", claim_status: "In Progress", available_statuses: ["To Do"] },
    },
    tracker: { jira: { site: "https://x.atlassian.net" } },
    t3: { provider: "codex", model: "test-model" },
    defaults: {},
    required: {},
  },
  settings: { host: "t3", agent: "codex", model: "test-model" },
  sources: { host: "default", agent: "default", model: "default" },
});

setDefaultTimeout(GIT_TEST_TIMEOUT_MS);

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function git(argv: string[], cwd: string, allowFailure = false) {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...argv], {
    cwd,
  });
  if (result.exitCode !== 0 && !allowFailure)
    throw new Error(`git ${argv.join(" ")}: ${result.stderr}`);
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
  others: Ticket[] = [];
  failing = new Set<TicketRef>();
  reads: TicketRef[] = [];
  transitions: string[] = [];
  onTransition: (fake: FakeJira) => void = (fake) => fake.set("Done");

  set(status: string) {
    this.ticket = { ...this.ticket, status, state: status === "Done" ? "closed" : "open" };
  }

  async read(ref: TicketRef) {
    this.reads.push(ref);
    if (this.failing.has(ref)) throw new Error(`Jira read issue failed (503): ${ref}`);
    const ticket = ref === this.ticket.ref ? this.ticket : this.others.find((t) => t.ref === ref);
    if (!ticket) throw new Error(`Jira read issue failed (404): ${ref}`);
    return { ticket, snapshot: { version: "1", payload: null } };
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
    authority?: boolean;
    mcp?: boolean;
    leaseExpiresAt?: string;
    pickedUp?: boolean;
    configuration?: ExecutionConfiguration;
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
    leaseExpiresAt: options.leaseExpiresAt ?? "2099-01-01T00:00:00Z",
    status: "active",
  });
  if (options.pickedUp)
    store.saveExecutionConfiguration(runRef, options.configuration ?? legacyPickupConfiguration);
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
  if (options.authority) {
    const claim = store.claim(claimRefSchema.parse("interlock-claim:complete"));
    const home = normalizeClaimHome(repo.origin);
    store.saveClaim({ ...claim, claimHome: home.identity, claimHomeUrl: home.url });
    const commands = new BunGitCommandExecutor();
    const lock = new GitClaimLock({
      repository: repo.main,
      home,
      git: commands,
      clock: { now: () => new Date(Date.parse(claim.leaseExpiresAt) - 60_000) },
    });
    await lock.claim({
      claim: claim.ref,
      run: runRef,
      ticket: ticketRef,
      owner: claim.humanOwner,
      leaseExpiresAt: claim.leaseExpiresAt,
      expectedVersion: (await lock.read(ticketRef)).version,
    });
    await new GitSubmissionAuthority(home, commands).reserve(
      {
        lane: created.value.id,
        run: runRef,
        claim: claim.ref,
        ticket: ticketRef,
        repository: "github.com/o/r",
        branch,
      },
      repo.main,
    );
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
  const services = {
    statePath,
    lane: {
      tracker,
      artifacts,
      ...(options.authority
        ? {}
        : { retirementAuthority: { verify: async () => {}, fence: async () => {} } }),
    },
    execution: {
      git: {
        async run(argv: readonly string[], cwd: string) {
          if (argv.join(" ") === "git ls-remote --get-url https://github.com/o/r.git")
            return { exitCode: 0, stdout: "https://github.com/o/r.git", stderr: "" };
          return (options.git ?? new BunGitCommandExecutor()).run(argv, cwd);
        },
      },
    },
  };
  const complete = async () => {
    if (options.mcp) {
      const server = new McpServer(createApplication(services));
      const response = await server.handle(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "lane_complete",
            arguments: { lane: created.value.id, state: statePath },
          },
        },
        server.newSession(),
      );
      const content = z
        .object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) })
        .parse(response).result.content;
      const result = JSON.parse(content.map((item) => item.text).join(""));
      return { code: result.ok ? 0 : 1, result };
    }
    const output: string[] = [];
    const code = await runCli(
      ["lane", "complete", created.value.id, "--state", statePath, "--json"],
      (text) => output.push(text),
      services,
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

test("MCP completion verifies shared remote ownership and preserves its reservation", async () => {
  const lane = await mergedLane({ authority: true, mcp: true, squash: true });
  const identity = {
    lane: lane.id,
    run: runRef,
    claim: claimRefSchema.parse("interlock-claim:complete"),
    ticket: ticketRef,
    repository: "github.com/o/r",
    branch,
  };
  const before = git(["ls-remote", lane.repo.origin, submissionRef(identity)], lane.repo.main);
  expect(before).not.toBe("");
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
  expect(git(["ls-remote", lane.repo.origin, submissionRef(identity)], lane.repo.main)).toBe(
    before,
  );
});

test("a released remote claim refuses even when the local run and claim still look active", async () => {
  const lane = await mergedLane({ authority: true });
  const home = normalizeClaimHome(lane.repo.origin);
  const lock = new GitClaimLock({
    repository: lane.repo.main,
    home,
    git: new BunGitCommandExecutor(),
  });
  await lock.release({
    claim: claimRefSchema.parse("interlock-claim:complete"),
    ticket: ticketRef,
    claimedOwner: actorRefSchema.parse("owner"),
    authorizedBy: actorRefSchema.parse("owner"),
    expectedVersion: (await lock.read(ticketRef)).version,
    originalSnapshot: { version: "1", payload: null },
  });
  expect((await lane.complete()).result.ok).toBe(false);
  expect(lane.tracker.transitions).toEqual([]);
  lane.intact();
});

test("missing shared submission reservation refuses without creating one", async () => {
  const lane = await mergedLane({ authority: true });
  const identity = {
    lane: lane.id,
    run: runRef,
    claim: claimRefSchema.parse("interlock-claim:complete"),
    ticket: ticketRef,
    repository: "github.com/o/r",
    branch,
  };
  git(["update-ref", "-d", submissionRef(identity)], lane.repo.origin);
  expect((await lane.complete()).result.ok).toBe(false);
  expect(git(["ls-remote", lane.repo.origin, submissionRef(identity)], lane.repo.main)).toBe("");
  lane.intact();
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`hidden tracked content under ${flag} is refused and preserved`, async () => {
    const lane = await mergedLane({ authority: true });
    git(["update-index", flag, "README"], lane.repo.lane);
    writeFileSync(join(lane.repo.lane, "README"), "irreplaceable content");
    expect((await lane.complete()).result).toMatchObject({
      ok: false,
      refusal: { code: "workspace_dirty" },
    });
    expect(readFileSync(join(lane.repo.lane, "README"), "utf8")).toBe("irreplaceable content");
    expect(lane.tracker.transitions).toEqual([]);
  });
}

test("symlink aliases of another lane's workspace refuse cleanup", async () => {
  const lane = await mergedLane({ authority: true });
  const alias = join(lane.repo.root, "alias");
  symlinkSync(lane.repo.lane, alias, "junction");
  changeStore(lane, (store) => {
    const otherRun = runRefSchema.parse("interlock-run:other");
    store.saveRun({ ...store.run(runRef), ref: otherRun, workspace: { path: alias, branch } });
    store.saveLane({
      ...store.lane(lane.id),
      id: laneRefSchema.parse("interlock-lane:other"),
      run: otherRun,
      claim: claimRefSchema.parse("interlock-claim:other"),
    });
  });
  expect((await lane.complete()).result.ok).toBe(false);
  expect(existsSync(alias)).toBe(true);
  lane.intact();
});

test("ignored data arriving after final cleanliness check is preserved with the entire directory", async () => {
  const executor = new BunGitCommandExecutor();
  let written = false;
  const lane = await mergedLane({
    authority: true,
    git: {
      async run(argv, cwd) {
        if (argv[1] === "worktree" && argv[2] === "move") {
          writeFileSync(join(String(argv[3]), "private-local"), "irreplaceable late content");
          written = true;
        }
        return executor.run(argv, cwd);
      },
    },
  });
  const info = git(["rev-parse", "--git-path", "info/exclude"], lane.repo.main);
  writeFileSync(join(lane.repo.main, info), "private-local\n");
  const readmeBytes = readFileSync(join(lane.repo.lane, "README"));
  expect((await lane.complete()).result.ok).toBe(true);
  expect(written).toBe(true);
  changeStore(lane, (store) => {
    const plan = store.retirement(lane.id)?.plan;
    if (!plan) throw new Error("missing intent");
    const archive = join(
      plan.commonDirectory,
      "interlock-retired",
      plan.retainedRef.split("/").at(-1) ?? "",
      "files",
    );
    expect(readFileSync(join(archive, "private-local"), "utf8")).toBe("irreplaceable late content");
    expect(readFileSync(join(archive, "README")).equals(readmeBytes)).toBe(true);
  });
});

test("release and replacement claim during proof fetch prevent cleanup", async () => {
  const executor = new BunGitCommandExecutor();
  let repo: Awaited<ReturnType<typeof mergedLane>>["repo"] | undefined;
  let fetches = 0;
  let released = false;
  const lane = await mergedLane({
    authority: true,
    git: {
      async run(argv, cwd) {
        if (argv[1] === "fetch" && ++fetches === 2 && repo) {
          const lock = new GitClaimLock({
            repository: repo.main,
            home: normalizeClaimHome(repo.origin),
            git: executor,
          });
          await lock.release({
            claim: claimRefSchema.parse("interlock-claim:complete"),
            ticket: ticketRef,
            claimedOwner: actorRefSchema.parse("owner"),
            authorizedBy: actorRefSchema.parse("owner"),
            expectedVersion: (await lock.read(ticketRef)).version,
            originalSnapshot: { version: "1", payload: null },
          });
          await lock.claim({
            claim: claimRefSchema.parse("interlock-claim:new"),
            ticket: ticketRef,
            run: runRefSchema.parse("interlock-run:new"),
            owner: actorRefSchema.parse("new"),
            leaseExpiresAt: "2099-01-01T00:00:00Z",
            expectedVersion: (await lock.read(ticketRef)).version,
          });
          released = true;
          const workspace = new GitWorkspaceAdapter({
            name: "test",
            path: repo.main,
            worktreeRoot: join(repo.root, "worktrees"),
            baseBranch: "main",
            remote: "https://github.com/o/r.git",
          });
          await expect(
            workspace.prepare({ ticket: ticketRef, path: repo.lane, branch }),
          ).rejects.toThrow("using this ledger");
        }
        return executor.run(argv, cwd);
      },
    },
  });
  repo = lane.repo;
  expect((await lane.complete()).result.ok).toBe(false);
  expect(released).toBe(true);
  lane.intact();
});

test("retirement fence rejects a delayed original-owner release at the removal boundary", async () => {
  const executor = new BunGitCommandExecutor();
  let repo: Awaited<ReturnType<typeof mergedLane>>["repo"] | undefined;
  let denied = false;
  const lane = await mergedLane({
    authority: true,
    git: {
      async run(argv, cwd) {
        if (argv[1] === "worktree" && argv[2] === "move" && repo) {
          const lock = new GitClaimLock({
            repository: repo.main,
            home: normalizeClaimHome(repo.origin),
            git: executor,
          });
          await expect(
            lock.release({
              claim: claimRefSchema.parse("interlock-claim:complete"),
              ticket: ticketRef,
              claimedOwner: actorRefSchema.parse("owner"),
              authorizedBy: actorRefSchema.parse("owner"),
              expectedVersion: (await lock.read(ticketRef)).version,
              originalSnapshot: { version: "1", payload: null },
            }),
          ).rejects.toThrow();
          denied = true;
        }
        return executor.run(argv, cwd);
      },
    },
  });
  repo = lane.repo;
  expect((await lane.complete()).result.ok).toBe(true);
  expect(denied).toBe(true);
});

test("lost response after archival move resumes without deleting the preserved contents", async () => {
  const executor = new BunGitCommandExecutor();
  let interrupted = false;
  const lane = await mergedLane({
    authority: true,
    git: {
      async run(argv, cwd) {
        const result = await executor.run(argv, cwd);
        if (!interrupted && result.exitCode === 0 && argv[1] === "worktree" && argv[2] === "move") {
          interrupted = true;
          throw new Error("crash after move");
        }
        return result;
      },
    },
  });
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "cleanup_pending" },
  });
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
});

test("an expired claim lease does not block the retirement fence", async () => {
  const lane = await mergedLane({ authority: true, leaseExpiresAt: "2020-01-02T00:00:00.000Z" });
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
  expect(existsSync(lane.repo.lane)).toBe(false);
});

test("a branch tracking a stale local base is still deleted after verified integration", async () => {
  const lane = await mergedLane({ squash: true });
  git(["config", `branch.${branch}.remote`, "."], lane.repo.main);
  git(["config", `branch.${branch}.merge`, "refs/heads/main"], lane.repo.main);
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
  expect(git(["branch", "--list", branch], lane.repo.main)).toBe("");
  expect(git(["config", "--get-regexp", "^branch\\.task/JWB-909\\."], lane.repo.main, true)).toBe(
    "",
  );
});

test("a commit landing on a self-tracking branch before deletion is never lost", async () => {
  const executor = new BunGitCommandExecutor();
  let repo: Awaited<ReturnType<typeof mergedLane>>["repo"] | undefined;
  let extra = "";
  const lane = await mergedLane({
    git: {
      async run(argv, cwd) {
        if (repo && !extra && argv.includes("branch") && argv.includes("-d")) {
          const tree = git(["rev-parse", `${branch}^{tree}`], repo.main);
          extra = git(["commit-tree", tree, "-p", branch, "-m", "late"], repo.main);
          git(["update-ref", `refs/heads/${branch}`, extra], repo.main);
        }
        return executor.run(argv, cwd);
      },
    },
  });
  repo = lane.repo;
  git(["config", `branch.${branch}.remote`, "."], lane.repo.main);
  git(["config", `branch.${branch}.merge`, `refs/heads/${branch}`], lane.repo.main);
  expect((await lane.complete()).result).toMatchObject({ ok: false });
  expect(extra).not.toBe("");
  expect(git(["rev-parse", branch], lane.repo.main)).toBe(extra);
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
