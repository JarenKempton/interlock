import { z } from "zod";
import type { ClaimRequest, ReleaseClaimRequest } from "../contracts.ts";
import type { ActorRef, ClaimRef, RunRef, TicketRef } from "../model.ts";

export const CLAIM_RECORD_VERSION = 2;

export const claimMarkerSchema = z.object({
  claim: z.string(),
  run: z.string(),
  owner: z.string(),
  home: z.string(),
  version: z.literal(CLAIM_RECORD_VERSION),
});

export const lockedPayloadSchema = z.object({
  tracker: z.object({ version: z.string(), payload: z.unknown() }),
});

export class ClaimLockUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimLockUnavailableError";
  }
}

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
  read(ticket: TicketRef): Promise<ClaimLockState>;
  claim(request: ClaimRequest): Promise<void>;
  release(request: ReleaseClaimRequest): Promise<void>;
}

export interface RecoverableClaimLock extends ClaimLock {
  releasable(request: ReleaseClaimRequest): Promise<ClaimLockState>;
  restore(ticket: TicketRef, claim: ClaimRef): Promise<void>;
}

export function heldClaim(state: ClaimLockState): ClaimLockRecord | undefined {
  return state.record && state.record.action !== "release" ? state.record : undefined;
}
