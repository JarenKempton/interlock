import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GitClaimLock } from "../src/adapters/claims/git-lock.ts";
import { normalizeClaimHome } from "../src/domain/claim-home.ts";
import { ticketRefSchema } from "../src/domain/identifiers.ts";
import { GIT_TEST_TIMEOUT_MS } from "./fixtures/git-remote.ts";
import { pickupFixture } from "./fixtures/pickup-runtime.ts";

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
      const args = ["pickup", "TEST-492", "--config", f.config, "--t3-catalog", f.t3Catalog];
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
