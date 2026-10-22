import { z } from "zod";
import type { ClaimLockRecord, RecoverableClaimLock } from "../domain/claim-lock.ts";
import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
  type ReclaimRequest,
  type ReleaseClaimRequest,
  type RenewLeaseRequest,
  type RestoreClaimRequest,
} from "../domain/contracts.ts";
import type { ClaimRef, TicketRef, TrackerSnapshot } from "../domain/model.ts";
import type { Tracker } from "../domain/tracker.ts";

const lockedPayloadSchema = z.object({
  tracker: z.object({ version: z.string(), payload: z.unknown() }),
});

export class ClaimCoordinator {
  constructor(
    readonly lock: RecoverableClaimLock,
    readonly tracker: Tracker,
  ) {}

  async snapshotClaimState(ticket: TicketRef): Promise<TrackerSnapshot> {
    const tracker = (await this.tracker.read(ticket)).snapshot;
    const lock = await this.lock.read(ticket);
    return { version: lock.version, payload: { lock, tracker } };
  }

  async claim(request: ClaimRequest): Promise<void> {
    await this.lock.claim(request);
    await mirrorHeldLock(() => this.tracker.apply(request));
  }

  async verifyClaim(request: ClaimRequest): Promise<void> {
    await this.#requireHeld(request.ticket, request.claim, (held) =>
      sameHolder(held, request, undefined),
    );
    await this.tracker.verify({ ...request, state: "applied" });
  }

  async restoreClaimState(request: RestoreClaimRequest): Promise<void> {
    const restore = trackerRequest(request);
    await this.tracker.restore(restore);
    await this.tracker.verify({ ...restore, state: "restored" });
    await this.lock.restore(request.ticket, request.claim);
  }

  async verifyRestored(request: RestoreClaimRequest): Promise<void> {
    await this.tracker.verify({ ...trackerRequest(request), state: "restored" });
    await this.#requireNotHeld(request.ticket, request.claim);
  }

  async renewLease(request: RenewLeaseRequest): Promise<void> {
    await this.lock.renew(request);
  }

  async verifyLease(request: RenewLeaseRequest): Promise<void> {
    await this.#requireHeld(
      request.ticket,
      request.claim,
      (held) => held.leaseExpiresAt === request.leaseExpiresAt,
    );
    const held = heldClaim(await this.lock.read(request.ticket));
    if (!held) throw new AmbiguousTrackerResultError("Claim lock is no longer held");
    await this.tracker.verify({ ...held, state: "applied" });
  }

  async releaseClaim(request: ReleaseClaimRequest): Promise<void> {
    await this.lock.releasable(request);
    const restore = trackerRequest(request);
    await this.tracker.restore(restore);
    await this.tracker.verify({ ...restore, state: "restored" });
    await this.lock.release(request);
  }

  async verifyReleased(request: ReleaseClaimRequest): Promise<void> {
    await this.tracker.verify({ ...trackerRequest(request), state: "restored" });
    await this.#requireNotHeld(request.ticket, request.claim);
  }

  async reclaim(request: ReclaimRequest): Promise<void> {
    await this.lock.reclaim(request);
    await mirrorHeldLock(() => this.tracker.apply({ ...request, supersedes: request.staleClaim }));
  }

  async verifyReclaimed(request: ReclaimRequest): Promise<void> {
    await this.#requireHeld(request.ticket, request.claim, (held) =>
      sameHolder(held, request, request.staleClaim),
    );
    await this.tracker.verify({ ...request, supersedes: request.staleClaim, state: "applied" });
  }

  async #requireHeld(
    ticket: TicketRef,
    claim: ClaimRef,
    matches: (held: ClaimLockRecord) => boolean,
  ): Promise<void> {
    const held = heldClaim(await this.lock.read(ticket));
    if (held?.claim !== claim || !matches(held))
      throw new AmbiguousTrackerResultError("Claim lock could not be verified");
  }

  async #requireNotHeld(ticket: TicketRef, claim: ClaimRef): Promise<void> {
    if (heldClaim(await this.lock.read(ticket))?.claim === claim)
      throw new AmbiguousTrackerResultError("Claim lock is still held");
  }
}

async function mirrorHeldLock(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (error instanceof ClaimCollisionError)
      throw new Error("Tracker mirror conflicts with the held claim lock", { cause: error });
    throw error;
  }
}

function sameHolder(
  held: ClaimLockRecord,
  request: Pick<ClaimRequest, "run" | "owner" | "leaseExpiresAt">,
  supersedes: ClaimRef | undefined,
): boolean {
  return (
    held.run === request.run &&
    held.owner === request.owner &&
    held.leaseExpiresAt === request.leaseExpiresAt &&
    held.supersedes === supersedes
  );
}

function trackerRequest<T extends RestoreClaimRequest>(
  request: T,
): T & { claimedOwner: NonNullable<T["claimedOwner"]> } {
  if (!request.claimedOwner) throw new Error("Persisted claimed owner is required");
  const parsed = lockedPayloadSchema.safeParse(request.originalSnapshot.payload);
  if (!parsed.success) throw new Error("Original snapshot was not taken through the claim lock");
  return { ...request, claimedOwner: request.claimedOwner, originalSnapshot: parsed.data.tracker };
}

function heldClaim(state: import("../domain/claim-lock.ts").ClaimLockState) {
  return state.record && state.record.action !== "release" ? state.record : undefined;
}
