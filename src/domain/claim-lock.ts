import type { ClaimRequest, ReleaseClaimRequest, RenewLeaseRequest } from "./contracts.ts";
import type { ActorRef, ClaimRef, RunRef, TicketRef } from "./model.ts";

export interface ClaimLockRecord {
  action: "claim" | "renew" | "release" | "reclaim";
  ticket: TicketRef;
  claim: ClaimRef;
  run: RunRef;
  owner: ActorRef;
  leaseExpiresAt: string;
  supersedes?: ClaimRef | undefined;
  authorizedBy?: ActorRef | undefined;
}

export interface ClaimLockState {
  version: string;
  record: ClaimLockRecord | null;
}

export interface ClaimLock {
  describe(): Promise<{ conditional_update: true }>;
  read(ticket: TicketRef): Promise<ClaimLockState>;
  claim(request: ClaimRequest): Promise<void>;
  renew(request: RenewLeaseRequest): Promise<void>;
  release(request: ReleaseClaimRequest): Promise<void>;
}

export interface RecoverableClaimLock extends ClaimLock {
  releasable(request: ReleaseClaimRequest): Promise<ClaimLockState>;
  restore(ticket: TicketRef, claim: ClaimRef): Promise<void>;
}
