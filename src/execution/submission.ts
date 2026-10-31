import { GitClaimLock, heldClaim } from "../adapters/claims/git-lock.ts";
import { GitSubmissionAuthority } from "../adapters/submissions/git.ts";
import type { GitCommandExecutor } from "../adapters/workspaces/git.ts";
import { normalizeClaimHome } from "../domain/claim-home.ts";
import {
  type SubmissionAuthority,
  type SubmissionIdentity,
  SubmissionRefusal,
} from "../domain/submission.ts";
import type { StateStore } from "../persistence/state.ts";

export class RecordedSubmissionAuthority implements SubmissionAuthority {
  constructor(
    private readonly store: Pick<StateStore, "run" | "claim">,
    private readonly git: GitCommandExecutor,
  ) {}

  async reserve(identity: SubmissionIdentity, workspace: string): Promise<{ mayCreate: boolean }> {
    const run = this.store.run(identity.run);
    if (
      run.workspace.path !== workspace ||
      run.workspace.branch !== identity.branch ||
      run.status !== "claimed"
    )
      throw new SubmissionRefusal(
        "claim_collision",
        "Submission does not match the claimed run workspace",
      );
    let home = normalizeClaimHome(`https://${identity.repository}.git`);
    if (identity.ticket) {
      const claim = this.store.claim(identity.claim);
      if (
        run.ticket !== identity.ticket ||
        claim.ticket !== identity.ticket ||
        claim.run !== run.ref ||
        claim.status !== "active" ||
        !claim.claimHomeUrl ||
        !claim.claimHome
      )
        throw new SubmissionRefusal(
          "claim_collision",
          "Submission requires the recorded active ticket claim",
        );
      home = normalizeClaimHome(claim.claimHomeUrl);
      if (home.identity !== claim.claimHome)
        throw new SubmissionRefusal(
          "claim_collision",
          "Recorded claim home identity does not match",
        );
      const lock = new GitClaimLock({ repository: workspace, home, git: this.git });
      const held = heldClaim(await lock.read(identity.ticket));
      if (
        !held ||
        held.claim !== identity.claim ||
        held.run !== identity.run ||
        held.owner !== claim.humanOwner
      )
        throw new SubmissionRefusal(
          "claim_collision",
          "Remote claim is not held by this submission owner",
        );
    }
    return new GitSubmissionAuthority(home, this.git).reserve(identity, workspace);
  }
}
