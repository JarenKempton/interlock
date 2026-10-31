import { realpath } from "node:fs/promises";
import { GitClaimLock, heldClaim } from "../adapters/claims/git-lock.ts";
import type { GitCommandExecutor } from "../adapters/workspaces/git.ts";
import { normalizeClaimHome } from "../domain/claim-home.ts";
import type { Claim, Run } from "../domain/model.ts";

export interface AttachAuthority {
  verify(run: Run, claim: Claim, worktree: string): Promise<void>;
}

export class AttachRefusal extends Error {
  constructor(
    readonly code: "workspace_unknown" | "claim_collision",
    message: string,
  ) {
    super(message);
  }
}

export class RecordedAttachAuthority implements AttachAuthority {
  constructor(private readonly git: GitCommandExecutor) {}

  async verify(run: Run, claim: Claim, worktree: string): Promise<void> {
    const { path, branch } = run.workspace;
    if (!path || !branch)
      throw new AttachRefusal("workspace_unknown", "Run has no recorded worktree and branch");
    const expected = await canonical(path);
    const actual = await canonical(worktree);
    if (!expected || actual !== expected)
      throw new AttachRefusal(
        "workspace_unknown",
        `Worktree ${worktree} is not the claimed worktree ${path}`,
      );
    const top = await this.#output(["git", "rev-parse", "--show-toplevel"], worktree);
    if (!top || (await canonical(top)) !== expected)
      throw new AttachRefusal("workspace_unknown", `${worktree} is not a Git worktree root`);
    const current = await this.#output(["git", "symbolic-ref", "--short", "HEAD"], worktree);
    if (current !== branch)
      throw new AttachRefusal(
        "workspace_unknown",
        `Worktree is on ${current || "a detached HEAD"}, not the claimed branch ${branch}`,
      );
    if (!claim.claimHome || !claim.claimHomeUrl)
      throw new AttachRefusal("claim_collision", "Claim has no recorded claim home");
    const home = normalizeClaimHome(claim.claimHomeUrl);
    if (home.identity !== claim.claimHome)
      throw new AttachRefusal("claim_collision", "Recorded claim home identity does not match");
    let held: ReturnType<typeof heldClaim>;
    try {
      held = heldClaim(
        await new GitClaimLock({ repository: worktree, home, git: this.git }).read(run.ticket),
      );
    } catch {
      throw new AttachRefusal("claim_collision", "Remote claim lock could not be read");
    }
    if (
      !held ||
      held.claim !== claim.ref ||
      held.run !== run.ref ||
      held.owner !== claim.humanOwner ||
      held.ticket !== run.ticket
    )
      throw new AttachRefusal("claim_collision", "Remote claim is not held by this run");
  }

  async #output(argv: readonly string[], cwd: string): Promise<string | undefined> {
    try {
      const result = await this.git.run(argv, cwd);
      return result.exitCode === 0 ? result.stdout.trim() : undefined;
    } catch {
      return undefined;
    }
  }
}

async function canonical(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}
