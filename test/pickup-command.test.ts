import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GitClaimLock } from "../src/adapters/claims/git-lock.ts";
import { normalizeClaimHome } from "../src/domain/claim-home.ts";
import { ticketRefSchema } from "../src/domain/identifiers.ts";
import { checkedGit, GIT_TEST_TIMEOUT_MS } from "./fixtures/git-remote.ts";
import { commitFixture, pickupFixture } from "./fixtures/pickup-runtime.ts";

async function cli(root: string, cwd: string, args: string[]) {
  const child = Bun.spawn(
    [process.execPath, resolve("test/fixtures/pickup-command.ts"), ...args, "--json"],
    {
      env: { ...process.env, INTERLOCK_TEST_ROOT: root, INTERLOCK_TEST_CWD: cwd },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test(
  "CLI pickup dry-run, pickup, runs list, and claim release through real local Git",
  async () => {
    const f = await pickupFixture();
    const command = async (args: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve("test/fixtures/pickup-command.ts"),
          ...args,
          "--state",
          f.state,
          "--json",
        ],
        {
          env: { ...process.env, INTERLOCK_TEST_ROOT: f.root },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`CLI failed (${code}): ${stderr}`);
      return JSON.parse(stdout);
    };
    try {
      await f.saveJira();
      const args = [
        "pickup",
        "TEST-492",
        "--config",
        f.config,
        "--repo",
        f.remote.alice,
        "--t3-catalog",
        f.t3Catalog,
      ];
      const before = await readFile(resolve(f.root, "jira.json"), "utf8");
      const dry = await command([...args, "--dry-run"]);
      expect(dry).toMatchObject({
        state: "planned",
        branch: "task/TEST-492",
        worktree: f.worktree,
      });
      expect(dry.launch.message).toContain("Return the T3 launch arguments.");
      expect(existsSync(f.state)).toBe(false);
      expect(existsSync(f.worktree)).toBe(false);
      expect(await readFile(resolve(f.root, "jira.json"), "utf8")).toBe(before);
      const picked = await command(args);
      expect(picked.state).toBe("claimed");
      expect((await command(["runs", "list"]))[0]).toMatchObject({
        ref: picked.run,
        status: "claimed",
        workspace: { branch: "task/TEST-492" },
      });
      const remote = new GitClaimLock({
        repository: f.remote.alice,
        home: normalizeClaimHome(f.remote.remote),
        git: f.git,
      });
      const ticket = ticketRefSchema.parse("jira:example:TEST:ticket:TEST-492");
      expect((await remote.read(ticket)).record).toMatchObject({
        action: "claim",
        claim: picked.claim,
      });
      const claimedJira = await f.readJira();
      expect(claimedJira.issue.fields.status.name).toBe("In Progress");
      Reflect.deleteProperty(claimedJira.issue.fields, "parent");
      await writeFile(resolve(f.root, "jira.json"), JSON.stringify(claimedJira));
      expect(await command(["claim", "release", picked.claim])).toMatchObject({
        state: "released",
        mirror: "restored_verified",
      });
      expect((await remote.read(ticket)).record).toMatchObject({
        action: "release",
        claim: picked.claim,
      });
      expect((await f.readJira()).property).toBeNull();
      expect((await f.readJira()).issue.fields.status.name).toBe("To Do");
      expect(existsSync(f.worktree)).toBe(true);
    } finally {
      await f.dispose();
    }
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "CLI pickup dry-run in a repo with no interlock.toml; an old interlock.toml names its replacements",
  async () => {
    const f = await pickupFixture();
    try {
      await f.saveJira();
      const repo = f.remote.alice;
      await checkedGit(f.git, ["rm", "--quiet", "interlock.toml"], repo);
      await commitFixture(f.git, repo, "no shared config");
      await checkedGit(f.git, ["push", "--quiet", "origin", "main"], repo);
      for (const setting of [
        ["jira_site", "https://example.atlassian.net"],
        ["claim-home", f.remote.remote],
      ])
        expect((await cli(f.root, repo, ["config", "edit", "--set", ...setting])).code).toBe(0);
      const before = await readFile(resolve(f.root, "jira.json"), "utf8");
      const dry = await cli(f.root, repo, [
        "pickup",
        "TEST-492",
        "--t3-catalog",
        f.t3Catalog,
        "--dry-run",
      ]);
      expect(dry.code).toBe(0);
      expect(JSON.parse(dry.stdout)).toMatchObject({
        state: "planned",
        repository: "alice",
        branch: "task/TEST-492",
        worktree: f.worktree,
      });
      expect(existsSync(resolve(repo, "interlock.toml"))).toBe(false);
      expect(existsSync(f.worktree)).toBe(false);
      expect(await readFile(resolve(f.root, "jira.json"), "utf8")).toBe(before);
      await writeFile(
        resolve(repo, "interlock.toml"),
        'version = 1\n[maps.TEST-470]\nrepository = "test"\nclaim_status = "In Progress"\navailable_statuses = ["To Do"]\n',
      );
      const old = await cli(f.root, repo, ["pickup", "TEST-492", "--t3-catalog", f.t3Catalog]);
      expect(old.code).toBe(1);
      expect(old.stderr).toContain(
        "interlock.toml [maps] was removed: pickup reads blockers from the tracker",
      );
      expect(await readFile(resolve(f.root, "jira.json"), "utf8")).toBe(before);
    } finally {
      await f.dispose();
    }
  },
  GIT_TEST_TIMEOUT_MS,
);
