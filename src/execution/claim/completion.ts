import type { ClaimLock, ClaimLockRecord } from "../../domain/claim-lock.ts";
import type { Claim, Run } from "../../domain/model.ts";

export function completionRecordMatches(record: ClaimLockRecord | null, claim: Claim): boolean {
  return Boolean(
    record &&
    record.ticket === claim.ticket &&
    record.run === claim.run &&
    record.owner === claim.humanOwner &&
    (record.claim === claim.ref || record.claim.startsWith("interlock-claim:retirement-")),
  );
}

export async function releaseCompletedClaim(input: {
  lock: ClaimLock;
  claim: Claim;
  run: Run;
  removeMirror: () => Promise<void>;
  journal: (state: string, receipt: unknown) => void;
  releasePending: boolean;
}): Promise<string> {
  const { lock, claim, run, journal } = input;
  const before = await lock.read(claim.ticket);
  if (!completionRecordMatches(before.record, claim) || run.ref !== claim.run)
    throw new Error("Remote claim no longer authorizes completion");
  if (before.record?.action === "release" && !input.releasePending)
    throw new Error("Remote claim was released outside this completion");
  journal("completion_mirror_pending", { claim: claim.ref, run: run.ref });
  await input.removeMirror();
  journal("completion_mirror_removed", { claim: claim.ref, mirror: "removed_verified" });
  const current = await lock.read(claim.ticket);
  if (!completionRecordMatches(current.record, claim))
    throw new Error("Remote claim changed during mirror removal");
  if (current.record?.action === "release") {
    if (!input.releasePending || current.version !== before.version)
      throw new Error("Remote claim was released outside this completion");
  } else {
    if (current.version !== before.version || !current.record)
      throw new Error("Remote claim changed during completion");
    journal("completion_release_pending", {
      claim: current.record.claim,
      run: run.ref,
      expectedVersion: current.version,
    });
    await lock.release({
      ticket: claim.ticket,
      claim: current.record.claim,
      claimedOwner: claim.humanOwner,
      authorizedBy: claim.humanOwner,
      expectedVersion: current.version,
      originalSnapshot: claim.previousState,
    });
  }
  const verified = await lock.read(claim.ticket);
  if (verified.record?.action !== "release" || !completionRecordMatches(verified.record, claim))
    throw new Error("Completion release could not be verified");
  journal("completion_released", { claim: verified.record.claim, lockVersion: verified.version });
  return verified.version;
}
