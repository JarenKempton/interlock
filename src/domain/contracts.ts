import type {
  ActorRef,
  AdapterRef,
  CapabilitySet,
  ClaimRef,
  PreparedWorkspace,
  Run,
  RunRef,
  Ticket,
  TicketRef,
  TrackerSnapshot,
} from "./model.ts";

export interface ClaimRequest {
  claim: ClaimRef;
  run: RunRef;
  ticket: TicketRef;
  owner: ActorRef;
  leaseExpiresAt: string;
  expectedVersion: string;
}

export interface RenewLeaseRequest {
  claim: ClaimRef;
  ticket: TicketRef;
  leaseExpiresAt: string;
  expectedVersion: string;
}

export interface ReleaseClaimRequest {
  claim: ClaimRef;
  ticket: TicketRef;
  /** Persisted owner installed by the claim; required by guarded release implementations. */
  claimedOwner?: ActorRef;
  originalSnapshot: TrackerSnapshot;
  expectedVersion: string;
  authorizedBy: ActorRef;
}

export interface ReclaimRequest {
  staleClaim: ClaimRef;
  claim: ClaimRef;
  run: RunRef;
  ticket: TicketRef;
  owner: ActorRef;
  authorizedBy: ActorRef;
  leaseExpiresAt: string;
  expectedVersion: string;
  originalSnapshot: TrackerSnapshot;
}

export interface RestoreClaimRequest {
  ticket: TicketRef;
  claim: ClaimRef;
  /** Persisted owner installed by the claim; required for restart-safe restoration. */
  claimedOwner?: ActorRef;
  originalSnapshot: TrackerSnapshot;
}

export class ClaimCollisionError extends Error {
  readonly code = "claim_collision";

  constructor(message = "Claim state changed concurrently") {
    super(message);
    this.name = "ClaimCollisionError";
  }
}

export class AmbiguousTrackerResultError extends Error {
  readonly code = "ambiguous_tracker_result";

  constructor(message = "Tracker mutation result is ambiguous") {
    super(message);
    this.name = "AmbiguousTrackerResultError";
  }
}

export interface TrackerAdapter {
  describe(): Promise<CapabilitySet>;
  preflight(ticket: TicketRef): Promise<void>;
  getTicket(ticket: TicketRef): Promise<Ticket>;
  snapshotClaimState(ticket: TicketRef): Promise<TrackerSnapshot>;
  claim(request: ClaimRequest): Promise<void>;
  verifyClaim(request: ClaimRequest): Promise<void>;
  restoreClaimState(request: RestoreClaimRequest): Promise<void>;
  verifyRestored(request: RestoreClaimRequest): Promise<void>;
  renewLease(request: RenewLeaseRequest): Promise<void>;
  verifyLease(request: RenewLeaseRequest): Promise<void>;
  releaseClaim(request: ReleaseClaimRequest): Promise<void>;
  verifyReleased(request: ReleaseClaimRequest): Promise<void>;
  reclaim(request: ReclaimRequest): Promise<void>;
  verifyReclaimed(request: ReclaimRequest): Promise<void>;
}

/** Optional read surface implemented by adapters that can hydrate a complete map frontier. */
export interface FrontierTrackerAdapter extends TrackerAdapter {
  listMapTickets(map: import("./model.ts").MapRef): Promise<Ticket[]>;
}

export interface WorkspacePlan {
  ticket: TicketRef;
  path: string;
  branch: string;
}

export interface WorkspaceAdapter {
  preflight(ticket: Ticket): Promise<void>;
  plan(ticket: Ticket): Promise<WorkspacePlan>;
  prepare(plan: WorkspacePlan): Promise<PreparedWorkspace>;
}

export interface LaunchRequest {
  run: RunRef;
  ticket: Ticket;
  workspace: PreparedWorkspace;
  model?: string;
  effort?: string;
  context?: string;
}

export interface LaunchReceipt {
  sessionId?: string;
  pid?: number;
  tier: "prepare" | "launch" | "managed" | "lifecycle";
}

export class HarnessLaunchError extends Error {
  constructor(
    message: string,
    readonly receipt?: LaunchReceipt,
  ) {
    super(message);
    this.name = "HarnessLaunchError";
  }
}

export interface HarnessAdapter {
  describe(): Promise<CapabilitySet>;
  preflight(request: LaunchRequest): Promise<void>;
  launch(request: LaunchRequest): Promise<LaunchReceipt>;
  stop(receipt: LaunchReceipt): Promise<void>;
}

export interface Ledger {
  saveRun(run: Run): void | Promise<void>;
  saveClaim(claim: import("./model.ts").Claim): void | Promise<void>;
  commitClaim(claim: import("./model.ts").Claim, receipt: unknown): void | Promise<void>;
  commitRun(run: Run, state: string, receipt: unknown): void | Promise<void>;
  recordStep(run: RunRef, state: string, receipt?: unknown, error?: unknown): void | Promise<void>;
  saveRecoveryRequired(
    run: Run,
    receipt: unknown,
    error: unknown,
    evidence: unknown,
  ): void | Promise<void>;
}

export interface IdFactory {
  run(): RunRef;
  claim(): ClaimRef;
}

export interface Clock {
  now(): Date;
}

export interface PickupRequest {
  ticket: TicketRef;
  owner: ActorRef;
  harness: AdapterRef;
  model?: string;
  effort?: string;
  context?: string;
  requiredCapabilities?: CapabilitySet;
}
