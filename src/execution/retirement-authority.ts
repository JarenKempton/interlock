import { createHash } from "node:crypto";
import { GitClaimLock, heldClaim } from "../adapters/claims/git-lock.ts";
import { GitSubmissionAuthority } from "../adapters/submissions/git.ts";
import type { GitCommandExecutor } from "../adapters/workspaces/git.ts";
import { normalizeClaimHome } from "../domain/claim-home.ts";
import { claimRefSchema } from "../domain/identifiers.ts";
import { type RetirementIdentity, retirementIdentitySchema } from "../domain/retirement.ts";
import type { StateStore } from "../persistence/state.ts";

export interface RetirementAuthority {
  verify(identity: RetirementIdentity, repository: string, cwd: string): Promise<void>;
  fence(identity: RetirementIdentity, repository: string, cwd: string): Promise<void>;
}

export class RecordedRetirementAuthority implements RetirementAuthority {
  constructor(
    private readonly store: Pick<StateStore, "claim" | "findLane">,
    private readonly git: GitCommandExecutor,
  ) {}

  async fence(identity: RetirementIdentity, repository: string, cwd: string): Promise<void> {
    await this.verify(identity, repository, cwd);
    const claim = this.store.claim(identity.claim);
    if (!claim.claimHomeUrl) throw new Error("Missing claim home");
    const lock = new GitClaimLock({
      repository: cwd,
      home: normalizeClaimHome(claim.claimHomeUrl),
      git: this.git,
    });
    const state = await lock.read(identity.ticket);
    await lock.fenceRetirement(
      {
        claim: identity.claim,
        ticket: identity.ticket,
        run: identity.run,
        owner: claim.humanOwner,
        leaseExpiresAt: claim.leaseExpiresAt,
        expectedVersion: state.version,
      },
      retirementClaim(identity),
    );
  }

  async verify(identity: RetirementIdentity, repository: string, cwd: string): Promise<void> {
    const claim = this.store.claim(identity.claim);
    const lane = this.store.findLane(identity.lane);
    if (
      lane?.state !== "merged" ||
      lane.run !== identity.run ||
      lane.claim !== identity.claim ||
      lane.head !== identity.head ||
      lane.artifact !== identity.artifact ||
      claim.status !== "active" ||
      claim.ticket !== identity.ticket ||
      claim.run !== identity.run ||
      !claim.claimHome ||
      !claim.claimHomeUrl
    )
      throw new Error("Retirement requires the recorded active claim and merged lane");
    const home = normalizeClaimHome(claim.claimHomeUrl);
    if (home.identity !== claim.claimHome) throw new Error("Recorded claim home identity changed");
    const held = heldClaim(
      await new GitClaimLock({ repository: cwd, home, git: this.git }).read(identity.ticket),
    );
    if (
      !held ||
      (held.claim !== identity.claim && held.claim !== retirementClaim(identity)) ||
      held.run !== identity.run ||
      held.owner !== claim.humanOwner
    )
      throw new Error("Remote claim no longer authorizes this retirement");
    const reservation = await new GitSubmissionAuthority(home, this.git).read(
      {
        lane: identity.lane,
        run: identity.run,
        claim: identity.claim,
        ...(lane.ticket ? { ticket: lane.ticket } : {}),
        repository,
        branch: identity.branch,
      },
      cwd,
    );
    if (!reservation)
      throw new Error("No verified shared submission reservation authorizes retirement");
  }
}

function retirementClaim(identity: RetirementIdentity) {
  return claimRefSchema.parse(
    `interlock-claim:retirement-${createHash("sha256")
      .update(JSON.stringify(retirementIdentitySchema.parse(identity)))
      .digest("hex")}`,
  );
}
