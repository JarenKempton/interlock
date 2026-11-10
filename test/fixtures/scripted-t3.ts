import { expect } from "bun:test";
import { join } from "node:path";
import type { T3CommandResult, T3Process } from "../../src/adapters/hosts/t3/cli.ts";
import { checkedGit } from "./git-remote.ts";
import type { pickupFixture } from "./pickup-runtime.ts";

type Fixture = Awaited<ReturnType<typeof pickupFixture>>;

export const descriptor = async () => ({
  environmentId: "env-1",
  serverVersion: "0.1.8",
  orchestrationProtocolVersion: 2,
});

export class ScriptedT3 implements T3Process {
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

export function launchable(f: Fixture) {
  const t3 = new ScriptedT3(f);
  f.services.execution = {
    ...f.services.execution,
    t3: { process: t3, server: descriptor, sleep: async () => {} },
  };
  const { "t3-catalog": _catalog, ...input } = f.input;
  return { t3, input: { ...input, launch: true } };
}
