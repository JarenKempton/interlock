import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitClaimLock } from "../src/adapters/claims/git-lock.ts";
import { submissionRef } from "../src/adapters/submissions/git.ts";
import { BunGitCommandExecutor, GitWorkspaceAdapter } from "../src/adapters/workspaces/git.ts";
import { normalizeClaimHome } from "../src/domain/claim-home.ts";
import {
  actorRefSchema,
  claimRefSchema,
  laneRefSchema,
  runRefSchema,
} from "../src/domain/identifiers.ts";
import { GIT_TEST_TIMEOUT_MS } from "./fixtures/git-remote.ts";
import { branch, git, laneCompleteFixtures, runRef, ticketRef } from "./fixtures/lane-complete.ts";

setDefaultTimeout(GIT_TEST_TIMEOUT_MS);
const { mergedLane, changeStore } = laneCompleteFixtures();

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
