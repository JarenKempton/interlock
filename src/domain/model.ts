export type TrackerRef = string & { readonly __kind: "TrackerRef" };
export type WorkspaceRef = string & { readonly __kind: "WorkspaceRef" };
export type GroupRef = string & { readonly __kind: "GroupRef" };
export type MapRef = string & { readonly __kind: "MapRef" };
export type TicketRef = string & { readonly __kind: "TicketRef" };
export type RunRef = `interlock-run:${string}`;
export type ClaimRef = `interlock-claim:${string}`;
export type ActorRef = string & { readonly __kind: "ActorRef" };
export type AdapterRef = string & { readonly __kind: "AdapterRef" };

/** Protocol-stable capability identifiers. Additions are backward compatible; renames are not. */
export const CAPABILITIES = [
  "native_maps",
  "native_groups",
  "native_dependencies",
  "cross_map_dependencies",
  "atomic_assignment",
  "workflow_transition",
  "conditional_update",
  "native_properties",
  "claim_comments",
  "claim_identity",
  "lease_metadata",
  "resolution_comments",
  "artifact_links",
  "prompt_generation",
  "workspace_open",
  "process_launch",
  "session_create",
  "session_resume",
  "session_status",
  "session_interrupt",
  "session_close",
  "model_selection",
  "reasoning_selection",
  "context_selection",
  "tool_configuration",
  "visible_multi_session",
  "workspace_prepare",
  "environment_plan",
  "environment_start",
  "environment_readiness",
  "environment_logs",
  "environment_resume",
  "environment_stop",
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
  /** Latest tracker version verified for this claim; used to guard renewal/release. */
  currentVersion?: string;
  supersedes?: ClaimRef;
  supersededBy?: ClaimRef;
}

/** Lease expiry is observational: it never mutates assignment or claim ownership. */
export function claimStatusAt(claim: Claim, at: Date): ClaimStatus {
  if (claim.status !== "active") return claim.status;
  return at.getTime() >= Date.parse(claim.leaseExpiresAt) ? "stale" : "active";
}

export type ClaimLifecycleEvent =
  | "claimed"
  | "renewed"
  | "reclaimed"
  | "released"
  | "recovery_required";

/** Heartbeats remain machine-readable metadata; lifecycle boundaries are human-visible. */
export function claimEventRequiresComment(event: ClaimLifecycleEvent): boolean {
  return event !== "renewed";
}

export type RunStatus =
  | "planning"
  | "active"
  | "stopped"
  | "attention_required"
  | "recovery_required";

export interface PreparedWorkspace {
  path: string;
  branch?: string;
}

export type EnvironmentProfileRef = string & { readonly __kind: "EnvironmentProfileRef" };

export interface EnvironmentPlan {
  id: string;
  profile: EnvironmentProfileRef;
  summary: string;
  warnings: string[];
  credentialHandles: string[];
}

export interface EnvironmentStartAuthorization {
  kind: "human" | "policy";
  policy?: string;
}

export interface PreparedEnvironment {
  id: string;
  profile: EnvironmentProfileRef;
  readiness: Record<string, "ready" | "not_ready" | "external">;
  logReferences: string[];
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
  execution?: ExecutionReceipt;
  observation?: RunObservation;
}

export interface ExecutionReceipt {
  sessionId?: string;
  pid?: number;
  /** PID operations are forbidden unless this adapter-owned identity can be verified. */
  processIdentity?: string;
  tier: "prepare" | "launch" | "managed" | "lifecycle";
}

export type ObservedSessionState = "running" | "stopped" | "missing" | "unknown";

export interface RunObservation {
  state: ObservedSessionState;
  observedAt: string;
  detail?: string;
}

/** Stopping execution preserves workspace and claim/tracker ownership outside the run record. */
export function stopRun(run: Run, stoppedAt: Date): Run {
  return { ...run, status: "stopped", updatedAt: stoppedAt.toISOString() };
}
