import { z } from "zod";
import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
  type FrontierTrackerAdapter,
  type ReclaimRequest,
  type ReleaseClaimRequest,
  type RenewLeaseRequest,
  type RestoreClaimRequest,
} from "../../domain/contracts.ts";
import {
  type CapabilitySet,
  type ClaimRef,
  capabilities,
  type MapRef,
  type Ticket,
  type TicketRef,
  type TrackerSnapshot,
} from "../../domain/model.ts";
import { type ClaimLockRecord, type GitClaimLock, heldClaim } from "./git-lock.ts";

const lockedPayloadSchema = z.object({
  tracker: z.object({ version: z.string(), payload: z.unknown() }),
});

/** The Git lock decides ownership; the wrapped tracker only mirrors a lock that is already held. */
export class GitLockedTrackerAdapter implements FrontierTrackerAdapter {
  readonly #lock: GitClaimLock;
  readonly #tracker: FrontierTrackerAdapter;

  constructor(lock: GitClaimLock, tracker: FrontierTrackerAdapter) {
    this.#lock = lock;
    this.#tracker = tracker;
  }

  async describe(): Promise<CapabilitySet> {
    return {
      ...(await this.#tracker.describe()),
      ...capabilities("conditional_update", "claim_identity", "lease_metadata"),
    };
  }

  async preflight(ticket: TicketRef): Promise<void> {
    await this.#tracker.preflight(ticket);
    await this.#lock.read(ticket);
  }

  getTicket(ticket: TicketRef): Promise<Ticket> {
    return this.#tracker.getTicket(ticket);
  }

  listMapTickets(map: MapRef): Promise<Ticket[]> {
    return this.#tracker.listMapTickets(map);
  }

  async snapshotClaimState(ticket: TicketRef): Promise<TrackerSnapshot> {
    const tracker = await this.#tracker.snapshotClaimState(ticket);
    const lock = await this.#lock.read(ticket);
    return { version: lock.version, payload: { lock, tracker } };
  }

  async claim(request: ClaimRequest): Promise<void> {
    await this.#lock.claim(request);
    await mirrorHeldLock(() => this.#tracker.claim(request));
  }

  async verifyClaim(request: ClaimRequest): Promise<void> {
    await this.#requireHeld(request.ticket, request.claim, (held) =>
      sameHolder(held, request, undefined),
    );
    await this.#tracker.verifyClaim(request);
  }

  async restoreClaimState(request: RestoreClaimRequest): Promise<void> {
    await this.#tracker.restoreClaimState(trackerRequest(request));
    await this.#lock.restore(request.ticket, request.claim);
  }

  async verifyRestored(request: RestoreClaimRequest): Promise<void> {
    await this.#tracker.verifyRestored(trackerRequest(request));
    await this.#requireNotHeld(request.ticket, request.claim);
  }

  async renewLease(request: RenewLeaseRequest): Promise<void> {
    await this.#lock.renew(request);
  }

  async verifyLease(request: RenewLeaseRequest): Promise<void> {
    await this.#requireHeld(
      request.ticket,
      request.claim,
      (held) => held.leaseExpiresAt === request.leaseExpiresAt,
    );
    await this.#tracker.verifyLease(request);
  }

  async releaseClaim(request: ReleaseClaimRequest): Promise<void> {
    await this.#lock.releasable(request);
    await this.#tracker.releaseClaim(trackerRequest(request));
    await this.#lock.release(request);
  }

  async verifyReleased(request: ReleaseClaimRequest): Promise<void> {
    await this.#tracker.verifyReleased(trackerRequest(request));
    await this.#requireNotHeld(request.ticket, request.claim);
  }

  async reclaim(request: ReclaimRequest): Promise<void> {
    await this.#lock.reclaim(request);
    await mirrorHeldLock(() => this.#tracker.reclaim(trackerRequest(request)));
  }

  async verifyReclaimed(request: ReclaimRequest): Promise<void> {
    await this.#requireHeld(request.ticket, request.claim, (held) =>
      sameHolder(held, request, request.staleClaim),
    );
    await this.#tracker.verifyReclaimed(trackerRequest(request));
  }

  async #requireHeld(
    ticket: TicketRef,
    claim: ClaimRef,
    matches: (held: ClaimLockRecord) => boolean,
  ): Promise<void> {
    const held = heldClaim(await this.#lock.read(ticket));
    if (held?.claim !== claim || !matches(held))
      throw new AmbiguousTrackerResultError("Claim lock could not be verified");
  }

  async #requireNotHeld(ticket: TicketRef, claim: ClaimRef): Promise<void> {
    if (heldClaim(await this.#lock.read(ticket))?.claim === claim)
      throw new AmbiguousTrackerResultError("Claim lock is still held");
  }
}

/** Once the lock is held, a mirror conflict must compensate rather than end as a plain collision. */
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

function trackerRequest<T extends { originalSnapshot: TrackerSnapshot }>(request: T): T {
  const parsed = lockedPayloadSchema.safeParse(request.originalSnapshot.payload);
  if (!parsed.success) throw new Error("Original snapshot was not taken through the claim lock");
  return { ...request, originalSnapshot: parsed.data.tracker };
}
