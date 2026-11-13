import { afterEach, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitClaimLock } from "../../../src/adapters/git/claim-lock.ts";
import {
  BunGitCommandExecutor,
  type GitCommandExecutor,
} from "../../../src/adapters/git/workspace.ts";
import { createApplication } from "../../../src/app/application.ts";
import { run as runCli } from "../../../src/main.ts";
import {
  type ResolvedConfiguration,
  resolveConfiguration,
} from "../../../src/configuration/schema.ts";
import { normalizeClaimHome } from "../../../src/domain/claim/home.ts";
import {
  actorRefSchema,
  adapterRefSchema,
  claimRefSchema,
  laneRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../../../src/domain/refs/identifiers.ts";
import type { Ticket, TicketRef } from "../../../src/domain/model.ts";
import { createLane, type MergeProof, transitionLane } from "../../../src/domain/lane/lifecycle.ts";
import type { LaneTrackerPort } from "../../../src/execution/lane/service.ts";
import { callTool } from "../mcp/stdio-client.ts";
import { StateStore } from "../../../src/persistence/state.ts";
import { saveExecutionConfiguration } from "../../../src/configuration/store.ts";
import { gitLaneService } from "../../../src/app/lane/service.ts";

export type AfterApproval = "base_merge" | "edited_merge" | "octopus" | "commit";

export const ticketRef = ticketRefSchema.parse("jira:x:JWB:ticket:JWB-909");

export const runRef = runRefSchema.parse("interlock-run:complete");

export const branch = "task/JWB-909";

export const prUrl = "https://github.com/o/r/pull/9";

const now = "2026-01-01T00:00:00.000Z";

const pickupConfiguration: ResolvedConfiguration = {
  ...resolveConfiguration(undefined, { jira_site: "https://x.atlassian.net" }),
  repository: {
    name: "r",
    remote: "https://github.com/o/r.git",
    path: "/project/main",
    worktreeRoot: "/project/worktrees",
    baseBranch: "main",
  },
};

export function git(argv: string[], cwd: string, allowFailure = false) {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...argv], {
    cwd,
  });
  if (result.exitCode !== 0 && !allowFailure)
    throw new Error(`git ${argv.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export class FakeJira implements LaneTrackerPort {
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
  removals = 0;
  async removeMirror() {
    if (this.ticket.state !== "closed") throw new Error("Ticket is not Done");
    this.removals += 1;
  }
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

export function laneCompleteFixtures() {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function repository(options: {
    merged: boolean;
    squash?: boolean;
    afterApproval?: AfterApproval;
  }) {
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
    if (options.afterApproval) {
      writeFileSync(join(main, "base-change"), "moved on\n");
      git(["add", "base-change"], main);
      git(["commit", "--quiet", "-m", "base moved"], main);
      git(["push", "--quiet", "origin", "main"], main);
      if (options.afterApproval === "base_merge")
        git(["merge", "--quiet", "--no-ff", "-m", "Merge main", "main"], lane);
      else if (options.afterApproval === "octopus") {
        git(["switch", "--quiet", "-c", "side"], main);
        writeFileSync(join(main, "side-change"), "side\n");
        git(["add", "side-change"], main);
        git(["commit", "--quiet", "-m", "side"], main);
        git(["switch", "--quiet", "main"], main);
        git(["merge", "--quiet", "--no-ff", "-m", "Merge main and side", "main", "side"], lane);
      } else if (options.afterApproval === "edited_merge") {
        git(["merge", "--quiet", "--no-ff", "--no-commit", "main"], lane);
        writeFileSync(join(lane, "change"), "slipped into the merge\n");
        git(["commit", "--quiet", "-am", "Merge main"], lane);
      } else {
        writeFileSync(join(lane, "change"), "unreviewed\n");
        git(["commit", "--quiet", "-am", "unreviewed"], lane);
      }
    }
    const prHead = git(["rev-parse", "HEAD"], lane);
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
    return { root, main, lane, head, prHead, merge, originalMain, origin };
  }

  async function mergedLane(
    options: {
      merged?: boolean;
      prMerged?: boolean;
      tracker?: FakeJira;
      squash?: boolean;
      afterApproval?: AfterApproval;
      git?: GitCommandExecutor;
      state?: "approved" | "merged";
      onProof?: () => Promise<void>;
      mcp?: boolean;
      leaseExpiresAt?: string;
      pickedUp?: boolean;
      configuration?: ResolvedConfiguration;
    } = {},
  ) {
    const repo = repository({
      merged: options.merged ?? true,
      squash: options.squash ?? false,
      ...(options.afterApproval ? { afterApproval: options.afterApproval } : {}),
    });
    const statePath = join(repo.root, "interlock.db");
    const store = new StateStore(statePath);
    store.saveRun({
      ref: runRef,
      ticket: ticketRef,
      host: adapterRefSchema.parse("t3"),
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
      saveExecutionConfiguration(store, runRef, options.configuration ?? pickupConfiguration);
    const service = gitLaneService({ store });
    const created = transitionLane(
      createLane({ id: laneRefSchema.parse("interlock-lane:complete"), ticket: ticketRef }, now),
      { type: "attach", run: runRef, claim: claimRefSchema.parse("interlock-claim:complete") },
      now,
    );
    if (created.refusal) throw new Error(created.refusal.message);
    store.saveLane(created.lane);
    const evidence = [{ gate: "test", head: repo.head, url: "https://ci.test/abc" }];
    for (const command of [
      { type: "submit", artifact: prUrl, head: repo.head, evidence },
      { type: "begin_review" },
      { type: "verdict", head: repo.head, decision: "approved", findings: [] },
    ] as const) {
      const result = await service.apply(created.lane.id, command);
      if (!result.ok) throw new Error(result.refusal.message);
    }
    if (options.state === "merged")
      store.saveLane({ ...store.lane(created.lane.id), state: "merged" });
    {
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
      head: repo.prHead,
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
      pullRequests: async () => [{ url: prUrl, branch, state: "MERGED" as const }],
      open: async () => ({ url: prUrl, branch, state: "OPEN" as const }),
      merged: async (url: string) => {
        views.push(url);
        await options.onProof?.();
        return proof;
      },
    };
    const services = {
      statePath,
      lane: {
        tracker,
        artifacts,
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
    const complete = async (
      selector: { lane?: string; ticket?: string } = { ticket: "JWB-909" },
    ) => {
      if (options.mcp) {
        const { content } = await callTool(createApplication(services), "lane_complete", {
          ...selector,
          state: statePath,
        });
        const result = JSON.parse(content.map((item) => item.text).join(""));
        return { code: result.ok ? 0 : 1, result };
      }
      const output: string[] = [];
      const code = await runCli(
        [
          "lane",
          "complete",
          ...(selector.lane ? [selector.lane] : []),
          ...(selector.ticket ? ["--ticket", selector.ticket] : []),
          "--state",
          statePath,
          "--json",
        ],
        (text) => output.push(text),
        services,
      );
      return { code, result: JSON.parse(output.join("\n")) };
    };
    const intact = () => {
      expect(existsSync(repo.lane)).toBe(true);
      expect(git(["branch", "--list", branch], repo.main)).toContain(branch);
    };
    return {
      repo,
      tracker,
      views,
      complete,
      intact,
      id: created.lane.id,
      statePath,
      proof,
      artifacts,
    };
  }

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
  return { mergedLane, directories, changeStore };
}
