import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { heldClaim } from "../../../src/adapters/git/claim-lock.ts";
import { createApplication } from "../../../src/app/application.ts";
import { configurationOperations } from "../../../src/configuration/project-files.ts";
import { normalizeClaimHome } from "../../../src/domain/claim/home.ts";
import { shellWord } from "../../../src/execution/pickup/launch-prompt.ts";
import { checkedGit, GIT_TEST_TIMEOUT_MS } from "../../fixtures/git/remote.ts";
import { inspect, lock, pickupRuntimeFixtures, ref } from "../../fixtures/pickup/runtime-suite.ts";

const fixture = pickupRuntimeFixtures();

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
      host: "t3",
      harness: "codex",
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
  "a rejected Jira sign-in fails as a sign-in error, not as a missing Rank field",
  async () => {
    const f = await fixture();
    const request = f.jira.request.bind(f.jira);
    f.jira.request = async (method, path, body) => {
      if (path === "/rest/api/3/myself") return { status: 401 };
      if (path === "/rest/api/3/field") return { status: 200, body: [] };
      return request(method, path, body);
    };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      "Jira rejected the credentials (401); run interlock login jira or update JIRA_API_TOKEN",
    );
    expect((await lock(f).read(ref)).version).toBe("absent");
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

test(
  "an outward blocks link added during planning does not change pickup",
  async () => {
    const f = await fixture();
    let reads = 0;
    f.jira.fail = (method, path, after) => {
      if (!after && method === "GET" && path.includes(`/issue/TEST-492?`) && ++reads === 3)
        f.jira.issue.fields.issuelinks.push({
          type: { inward: "is blocked by", outward: "blocks" },
          outwardIssue: { key: "TEST-493", fields: { status: { name: "To Do" } } },
        });
    };
    const picked = await createApplication(f.services).pickup.execute(f.input);
    expect(reads).toBeGreaterThan(3);
    expect(picked).toMatchObject({ state: "claimed" });
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "the launch message's attach command, run from the new worktree, binds the lane to the pickup",
  async () => {
    const f = await fixture();
    await configurationOperations({ cwd: f.root, statePath: f.state }).edit({
      set: ["reviewers", "correctness, security"],
    });
    const result = await createApplication(f.services).pickup.execute(f.input);
    if (!("run" in result)) throw new Error("Expected a claimed plan");
    expect(Object.keys(result.reviewers)).toEqual(["correctness", "security"]);
    const target = JSON.stringify({
      providerInstanceId: "codex",
      model: "test-model",
      options: { reasoningEffort: "high" },
    });
    expect(result.launch.message).toContain(`   - correctness: target ${target}`);
    expect(result.launch.message).toContain("watch_pull_request");
    const attach = /`([^`]* lane attach [^`]*)`/.exec(result.launch.message)?.[1];
    if (!attach) throw new Error("Launch message has no attach command");
    expect(attach).toContain(`--ticket ${ref}`);
    expect(attach).toContain(`--state ${shellWord(f.state)}`);
    const argv = [...attach.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map(
      (word) => word[2] ?? (word[1] ?? "").replaceAll("'\\''", "'"),
    );
    const child = Bun.spawnSync(argv, { cwd: f.worktree });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({
      ok: true,
      value: { ticket: ref, run: result.run, claim: result.claim, state: "implementing" },
    });
    const elsewhere = Bun.spawnSync(argv, { cwd: f.remote.alice });
    expect(elsewhere.exitCode).toBe(1);
    expect(JSON.parse(elsewhere.stdout.toString()).refusal.code).toBe("workspace_unknown");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a relative --state is embedded in the launch commands as the absolute ledger pickup used",
  async () => {
    const f = await fixture();
    const result = await createApplication(f.services).pickup.execute({
      ...f.input,
      state: "relative/ledger.db",
      "dry-run": true,
    });
    expect(result.launch.message).toContain(`--state ${shellWord(resolve("relative/ledger.db"))}`);
    expect(result.launch.message).not.toContain("--state relative/");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a stale local base does not leak into the task branch: it starts at the fetched origin tip",
  async () => {
    const f = await fixture();
    const alice = f.remote.alice;
    const run = async (...argv: string[]) => checkedGit(f.git, argv, alice);
    const stale = (await run("rev-parse", "HEAD")).trim();
    await run(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "landed on origin",
    );
    await run("push", "--quiet", "origin", "main");
    const tip = (await run("rev-parse", "HEAD")).trim();
    await run("reset", "--quiet", "--hard", stale);
    await run("update-ref", "refs/remotes/origin/main", stale);
    const result = await createApplication(f.services).pickup.execute(f.input);
    expect(result.state).toBe("claimed");
    expect((await checkedGit(f.git, ["rev-parse", "HEAD"], f.worktree)).trim()).toBe(tip);
    expect((await run("rev-parse", "main")).trim()).toBe(stale);
    expect(
      (await f.git.run(["git", "rev-parse", "--abbrev-ref", "task/TEST-492@{upstream}"], alice))
        .exitCode,
    ).not.toBe(0);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a failed base fetch refuses pickup before any claim, mirror write or worktree",
  async () => {
    const f = await fixture();
    const git = f.git;
    f.services.execution = {
      ...f.services.execution,
      git: {
        async run(argv, cwd) {
          if (argv[1] === "fetch" && argv.at(-1)?.startsWith("+refs/heads/"))
            return { exitCode: 128, stdout: "", stderr: "fatal: unable to access origin" };
          return git.run(argv, cwd);
        },
      },
    };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      "Cannot fetch main from origin",
    );
    expect((await lock(f).read(ref)).version).toBe("absent");
    expect(f.jira.property).toBeNull();
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "dry-run makes no base fetch of its own",
  async () => {
    const f = await fixture();
    const fetches: string[][] = [];
    const git = f.git;
    f.services.execution = {
      ...f.services.execution,
      git: {
        async run(argv, cwd) {
          if (argv[1] === "fetch") fetches.push([...argv]);
          return git.run(argv, cwd);
        },
      },
    };
    await createApplication(f.services).pickup.execute({ ...f.input, "dry-run": true });
    expect(fetches.filter((argv) => argv.at(-1)?.startsWith("+refs/heads/"))).toEqual([]);
    await createApplication(f.services).pickup.execute(f.input);
    expect(fetches.filter((argv) => argv.at(-1)?.startsWith("+refs/heads/"))).toHaveLength(1);
  },
  GIT_TEST_TIMEOUT_MS,
);
