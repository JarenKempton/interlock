import { expect, test } from "bun:test";
import { basename, join } from "node:path";
import type { T3CommandResult, T3Process } from "../../../src/adapters/hosts/t3/cli.ts";
import { createApplication } from "../../../src/application.ts";
import { checkedGit, GIT_TEST_TIMEOUT_MS } from "../../fixtures/git-remote.ts";
import { inspect, lock, pickupRuntimeFixtures, ref } from "../../fixtures/pickup-runtime-suite.ts";
import { rejection } from "../../fixtures/rejection.ts";

const fixture = pickupRuntimeFixtures();
const descriptor = async () => ({
  environmentId: "env-1",
  serverVersion: "0.1.8",
  orchestrationProtocolVersion: 2,
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

class ScriptedT3 implements T3Process {
  readonly calls: string[][] = [];
  version = "t3 v0.1.8-nightly.1\n";
  start: "worktree" | "silent" | "fail" = "worktree";
  bound: { path: string; branch: string; title: string } | undefined;

  constructor(readonly f: Fixture) {}

  async run(argv: readonly string[], stdin?: string): Promise<T3CommandResult> {
    this.calls.push(argv.slice(1));
    const [, command, subcommand] = argv;
    const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
    if (command === "--version") return { exitCode: 0, stdout: this.version, stderr: "" };
    if (command !== "thread") return { exitCode: 1, stdout: "", stderr: "unexpected" };
    if (subcommand === "list") return ok([]);
    if (subcommand === "start") {
      if (this.start === "fail") return { exitCode: 1, stdout: "", stderr: "launch failed" };
      if (this.start === "silent") return { exitCode: 0, stdout: "", stderr: "" };
      const base = argv[argv.indexOf("--worktree") + 1] ?? "";
      const branch = argv[argv.indexOf("--branch") + 1] ?? "";
      const path = join(this.f.root, "t3-worktrees", "TEST-492");
      await checkedGit(
        this.f.remote.git,
        ["worktree", "add", "--no-track", "-b", branch, path, base],
        this.f.remote.alice,
      );
      this.bound = { path, branch, title: argv[argv.indexOf("--title") + 1] ?? "" };
      expect(stdin).toContain("interlock");
      return ok({ threadId: "thread-1", projectId: "project-1", runId: "run-1" });
    }
    if (subcommand === "show" && this.bound)
      return ok({
        thread: {
          threadId: "thread-1",
          projectId: "project-1",
          title: this.bound.title,
          link: "https://app.t3.codes/threads/env-1/thread-1",
          status: "running",
          providerInstanceId: "claudeAgent",
          model: "claude-opus-5-5",
          branch: this.bound.branch,
          worktreePath: this.bound.path,
        },
        messages: [],
      });
    return { exitCode: 1, stdout: "", stderr: "Thread not found" };
  }
}

function launchable(f: Fixture) {
  const t3 = new ScriptedT3(f);
  f.services.execution = {
    ...f.services.execution,
    t3: { process: t3, server: descriptor, sleep: async () => {} },
  };
  const { "t3-catalog": _catalog, ...input } = f.input;
  return { t3, input: { ...input, launch: true } };
}

async function title(f: Fixture) {
  const planned = await createApplication(f.services).pickup.execute({
    ...f.input,
    "t3-catalog": undefined,
    "dry-run": true,
  });
  return planned.title;
}

test(
  "--launch claims, then starts one T3 thread on the fetched base commit and adopts its worktree",
  async () => {
    const f = await fixture();
    expect(await title(f)).toBe("TEST-492: Prepare a real pickup");
    const { t3, input } = launchable(f);
    const result = await createApplication(f.services).pickup.execute(input);
    const base = await checkedGit(
      f.remote.git,
      ["rev-parse", "refs/remotes/origin/main"],
      f.remote.alice,
    );
    const start = t3.calls.find((call) => call[1] === "start") ?? [];
    expect(start.slice(0, 9)).toEqual([
      "thread",
      "start",
      join(f.root, basename(f.remote.alice)),
      "-",
      "--title",
      "TEST-492: Prepare a real pickup",
      "--worktree",
      base,
      "--branch",
    ]);
    expect(t3.calls.filter((call) => call[1] === "start")).toHaveLength(1);
    expect(t3.calls.findIndex((call) => call[0] === "--version")).toBe(0);
    expect(result).toMatchObject({
      state: "claimed",
      worktree: join(f.root, "t3-worktrees", "TEST-492"),
      session: {
        id: "thread-1",
        environment: "env-1",
        harness: "claudeAgent",
        branch: "task/TEST-492",
        worktree: join(f.root, "t3-worktrees", "TEST-492"),
      },
    });
    const run = inspect(f, (store) => store.listRuns()[0]);
    expect(run?.workspace).toEqual({
      path: join(f.root, "t3-worktrees", "TEST-492"),
      branch: "task/TEST-492",
      ticket: ref,
    });
    const attached = await createApplication(f.services).lane.attach.execute({
      ticket: ref,
      worktree: join(f.root, "t3-worktrees", "TEST-492"),
      state: f.state,
    });
    expect(attached).toMatchObject({ ok: true, value: { state: "implementing" } });
    if (result.dryRun || !("value" in attached)) throw new Error("expected a claimed lane");
    expect(result.session?.lane).toBe(attached.value.id);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "an incompatible t3 CLI refuses before any claim or launch",
  async () => {
    const f = await fixture();
    const { t3, input } = launchable(f);
    t3.version = "t3 v0.1.6\n";
    expect(
      (await rejection(createApplication(f.services).pickup.execute(input))).message,
    ).toContain("host_incompatible");
    expect(t3.calls.some((call) => call[1] === "start")).toBe(false);
    expect((await lock(f).read(ref)).version).toBe("absent");
    expect(f.jira.property).toBeNull();
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "an existing task branch on origin refuses before any claim",
  async () => {
    const f = await fixture();
    const { t3, input } = launchable(f);
    await checkedGit(
      f.remote.git,
      ["push", "--quiet", "origin", "main:task/TEST-492"],
      f.remote.alice,
    );
    expect(
      (await rejection(createApplication(f.services).pickup.execute(input))).message,
    ).toContain("branch_exists: Branch task/TEST-492 already exists");
    expect(t3.calls.some((call) => call[1] === "start")).toBe(false);
    expect((await lock(f).read(ref)).version).toBe("absent");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "exit 0 without a readable thread keeps the claim, requires recovery and never relaunches",
  async () => {
    const f = await fixture();
    const { t3, input } = launchable(f);
    t3.start = "silent";
    expect(
      (await rejection(createApplication(f.services).pickup.execute(input))).message,
    ).toContain("Pickup ended in recovery_required");
    expect(t3.calls.filter((call) => call[1] === "start")).toHaveLength(1);
    expect(inspect(f, (store) => store.listRuns()[0]?.status)).toBe("recovery_required");
    expect((await lock(f).read(ref)).record?.action).not.toBe("release");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a failed start with no thread and no branch is proven not launched and compensates",
  async () => {
    const f = await fixture();
    const { t3, input } = launchable(f);
    t3.start = "fail";
    expect(
      (await rejection(createApplication(f.services).pickup.execute(input))).message,
    ).toContain("Pickup ended in compensated");
    expect(t3.calls.filter((call) => call[1] === "start")).toHaveLength(1);
    expect(inspect(f, (store) => store.listRuns()[0]?.status)).toBe("compensated");
  },
  GIT_TEST_TIMEOUT_MS,
);
