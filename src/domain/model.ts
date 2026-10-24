export type TrackerRef = string & { readonly __kind: "TrackerRef" };
export type WorkspaceRef = string & { readonly __kind: "WorkspaceRef" };
export type GroupRef = string & { readonly __kind: "GroupRef" };
export type MapRef = string & { readonly __kind: "MapRef" };
export type TicketRef = string & { readonly __kind: "TicketRef" };
export type RunRef = `interlock-run:${string}`;
export type ClaimRef = `interlock-claim:${string}`;
export type ActorRef = string & { readonly __kind: "ActorRef" };
export type AdapterRef = string & { readonly __kind: "AdapterRef" };

/** Capability identifiers adapters may advertise. Additions are backward compatible; renames are not. */
export const CAPABILITIES = [
  "conditional_update",
  "model_selection",
  "reasoning_selection",
  "context_selection",
  "workspace_prepare",
] as const;

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
  ticketKeyWorkspaces?: boolean;
}

export type PolicySet = Record<string, unknown>;

export interface NativeReference {
  id: string;
  url?: string;
}

export interface Workspace {
  ref: WorkspaceRef;
  tracker: TrackerRef;
  repository?: RepositorySpec;
  policies?: PolicySet;
  capabilities: CapabilitySet;
}

export interface WorkGroup {
  ref: GroupRef;
  parent?: GroupRef;
  maps: MapRef[];
  native: NativeReference;
}

export interface TrackerMap {
  ref: MapRef;
  group?: GroupRef;
  tickets: TicketRef[];
  order: number;
  native: NativeReference;
}

export type TicketKind = "task" | "research" | "prototype" | "decision";
export type TicketState = "open" | "closed";
export type DependencyKind = "blocks";

export interface Dependency {
  blocking: TicketRef;
  blocked: TicketRef;
  kind: DependencyKind;
}

export type Ticket = import("zod").z.infer<typeof import("./tickets.ts").ticketSchema>;

export interface TrackerSnapshot {
  version: string;
  payload: unknown;
}

export type ClaimStatus = "active" | "stale" | "released" | "superseded";

export interface Claim {
  ref: ClaimRef;
  ticket: TicketRef;
  humanOwner: ActorRef;
  run: RunRef;
  previousState: TrackerSnapshot;
  claimedAt: string;
  leaseExpiresAt: string;
  status: ClaimStatus;
  currentVersion?: string;
  supersedes?: ClaimRef;
  supersededBy?: ClaimRef;
}

/** Lease expiry is observational: it never mutates assignment or claim ownership. */
export function claimStatusAt(claim: Claim, at: Date): ClaimStatus {
  if (claim.status !== "active") return claim.status;
  return at.getTime() >= Date.parse(claim.leaseExpiresAt) ? "stale" : "active";
}

export type RunStatus =
  | "planning"
  | "claimed"
  | "active"
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
  effort?: string;
  context?: string;
  workspace: PreparedWorkspace;
  capabilities: CapabilitySet;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  execution?: import("./contracts.ts").LaunchReceipt;
}
