import type { ClaimRequest, ReleaseClaimRequest } from "./contracts.ts";
import type { ActorRef, ClaimRef, RunRef, TicketRef } from "./model.ts";

export const CLAIM_RECORD_VERSION = 2;

export interface ClaimLockRecord {
  action: "claim" | "release";
  ticket: TicketRef;
  claim: ClaimRef;
  run: RunRef;
  owner: ActorRef;
  leaseExpiresAt: string;
  home: string;
  version: typeof CLAIM_RECORD_VERSION;
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
  release(request: ReleaseClaimRequest): Promise<void>;
}

export interface RecoverableClaimLock extends ClaimLock {
  releasable(request: ReleaseClaimRequest): Promise<ClaimLockState>;
  restore(ticket: TicketRef, claim: ClaimRef): Promise<void>;
}
