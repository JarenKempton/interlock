import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BunGitCommandExecutor,
  type CommandResult,
  type GitCommandExecutor,
} from "../../src/adapters/workspaces/git.ts";

export interface GitRemoteFixture {
  remote: string;
  alice: string;
  bob: string;
  dispose(): Promise<void>;
}

export async function gitRemoteFixture(): Promise<GitRemoteFixture> {
  const root = await mkdtemp(join(tmpdir(), "interlock-claim-lock-"));
  const fixture = {
    remote: join(root, "remote.git"),
    alice: join(root, "alice"),
    bob: join(root, "bob"),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
  await git(["init", "--bare", "--quiet", fixture.remote], root);
  await git(["init", "--quiet", fixture.alice], root);
  await git(["init", "--quiet", fixture.bob], root);
  return fixture;
}

export async function git(argv: readonly string[], cwd: string): Promise<string> {
  const result = await new BunGitCommandExecutor().run(["git", ...argv], cwd);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** Real Git with an injectable push outcome, recording every argv for force-push assertions. */
export class ScriptedGit implements GitCommandExecutor {
  readonly calls: (readonly string[])[] = [];
  beforePush: (() => Promise<void>) | undefined;
  push: ((run: () => Promise<CommandResult>) => Promise<CommandResult>) | undefined;
  lsRemoteFailuresAfterPush = 0;
  #pushed = false;
  readonly #git = new BunGitCommandExecutor();

  async run(argv: readonly string[], cwd: string): Promise<CommandResult> {
    this.calls.push(argv);
    const real = () => this.#git.run(argv, cwd);
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
