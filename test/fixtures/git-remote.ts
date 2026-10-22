import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BunGitCommandExecutor,
  type CommandResult,
  type GitCommandExecutor,
} from "../../src/adapters/workspaces/git.ts";

export const GIT_TEST_TIMEOUT_MS = 60_000;

export interface GitRemoteFixture {
  remote: string;
  alice: string;
  bob: string;
  git: GitCommandExecutor;
  clock: { now(): Date; set(iso: string): void };
  dispose(): Promise<void>;
}

/** Owns every Git process it starts, so disposal can drain them before deleting the directory. */
class FixtureGit implements GitCommandExecutor {
  readonly #inFlight = new Set<Promise<CommandResult>>();
  readonly #git = new BunGitCommandExecutor();
  #closed = false;

  run(argv: readonly string[], cwd: string): Promise<CommandResult> {
    if (this.#closed) return Promise.reject(new Error("Git fixture was disposed"));
    const running = this.#git.run(argv, cwd);
    this.#inFlight.add(running);
    void running.finally(() => this.#inFlight.delete(running)).catch(() => undefined);
    return running;
  }

  async close(): Promise<void> {
    this.#closed = true;
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
  }
}

export async function gitRemoteFixture(): Promise<GitRemoteFixture> {
  const root = await mkdtemp(join(tmpdir(), "interlock-claim-lock-"));
  const git = new FixtureGit();
  let now = new Date("2026-10-22T00:00:00.000Z");
  const fixture: GitRemoteFixture = {
    remote: join(root, "remote.git"),
    alice: join(root, "alice"),
    bob: join(root, "bob"),
    git,
    clock: {
      now: () => now,
      set: (iso) => {
        now = new Date(iso);
      },
    },
    dispose: async () => {
      await git.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  await checkedGit(git, ["init", "--bare", "--quiet", fixture.remote], root);
  await checkedGit(git, ["init", "--quiet", fixture.alice], root);
  await checkedGit(git, ["init", "--quiet", fixture.bob], root);
  return fixture;
}

export async function checkedGit(
  git: GitCommandExecutor,
  argv: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await git.run(["git", ...argv], cwd);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** Fixture Git with an injectable push outcome, recording every argv for force-push assertions. */
export class ScriptedGit implements GitCommandExecutor {
  readonly calls: (readonly string[])[] = [];
  beforePush: (() => Promise<void>) | undefined;
  push: ((run: () => Promise<CommandResult>) => Promise<CommandResult>) | undefined;
  lsRemoteFailuresAfterPush = 0;
  #pushed = false;

  constructor(readonly git: GitCommandExecutor) {}

  async run(argv: readonly string[], cwd: string): Promise<CommandResult> {
    this.calls.push(argv);
    const real = () => this.git.run(argv, cwd);
    if (argv[1] === "push") {
      this.#pushed = true;
      const before = this.beforePush;
      this.beforePush = undefined;
      await before?.();
      const push = this.push;
      this.push = undefined;
      return push ? push(real) : real();
    }
    if (argv[1] === "ls-remote" && this.#pushed && this.lsRemoteFailuresAfterPush > 0) {
      this.lsRemoteFailuresAfterPush -= 1;
      return { exitCode: 128, stdout: "", stderr: "fatal: unable to access remote" };
    }
    return real();
  }
}
