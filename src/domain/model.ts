export type MapRef = string & { readonly __kind: "MapRef" };
export type TicketRef = string & { readonly __kind: "TicketRef" };
export type RunRef = `interlock-run:${string}`;
export type ClaimRef = `interlock-claim:${string}`;
export type LaneRef = `interlock-lane:${string}`;
export type ActorRef = string & { readonly __kind: "ActorRef" };
export type AdapterRef = string & { readonly __kind: "AdapterRef" };

/** Capability identifiers adapters may advertise. Additions are backward compatible; renames are not. */
export const CAPABILITIES = ["conditional_update"] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilitySet = Partial<Record<Capability, true>>;

export function capabilities(...values: Capability[]): CapabilitySet {
  const result: CapabilitySet = {};
  for (const value of values) result[value] = true;
  return result;
}

export function missingCapabilities(
  available: CapabilitySet,
  required: CapabilitySet,
): Capability[] {
  return CAPABILITIES.filter((item) => required[item] && !available[item]);
}

export class UnsupportedCapabilityError extends Error {
  readonly code = "unsupported_capability";

  constructor(readonly missing: readonly Capability[]) {
    super(`Unsupported capabilities: ${missing.join(", ")}`);
    this.name = "UnsupportedCapabilityError";
  }
}

/** Fails before an operation when its adapter cannot verify every required capability. */
export function requireCapabilities(available: CapabilitySet, required: CapabilitySet): void {
  const missing = missingCapabilities(available, required);
  if (missing.length > 0) throw new UnsupportedCapabilityError(missing);
}

export interface RepositorySpec {
  name: string;
  remote: string;
  path: string;
  worktreeRoot: string;
  baseBranch: string;
}

export type TicketKind = "task" | "research" | "prototype" | "decision";

export interface Dependency {
  blocking: TicketRef;
  blocked: TicketRef;
  kind: "blocks";
}

export type Ticket = import("zod").z.infer<typeof import("./tickets.ts").ticketSchema>;

export interface TrackerSnapshot {
  version: string;
  payload: unknown;
}

export interface Claim {
  ref: ClaimRef;
  ticket: TicketRef;
  humanOwner: ActorRef;
  run: RunRef;
  previousState: TrackerSnapshot;
  claimedAt: string;
  leaseExpiresAt: string;
  status: "active" | "released";
  currentVersion?: string;
}

type RunStatus =
  | "planning"
  | "claimed"
  | "compensated"
  | "collision"
  | "released"
  | "recovery_required";

export interface PreparedWorkspace {
  path: string;
  branch?: string;
}

export interface Run {
  ref: RunRef;
  ticket: TicketRef;
  harness: AdapterRef;
  model?: string;
  workspace: PreparedWorkspace;
  capabilities: CapabilitySet;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}
