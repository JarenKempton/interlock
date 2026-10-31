import { z } from "zod";
import {
  actorRefSchema,
  adapterRefSchema,
  claimRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "./identifiers.ts";

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

export type Ticket = z.infer<typeof import("./tickets.ts").ticketSchema>;

export const trackerSnapshotSchema = z.strictObject({
  version: z.string(),
  payload: z.unknown(),
});
export type TrackerSnapshot = z.infer<typeof trackerSnapshotSchema>;

export const claimSchema = z.strictObject({
  ref: claimRefSchema,
  ticket: ticketRefSchema,
  humanOwner: actorRefSchema,
  run: runRefSchema,
  previousState: trackerSnapshotSchema,
  claimedAt: z.string(),
  leaseExpiresAt: z.string(),
  status: z.enum(["active", "released"]),
  currentVersion: z.string().optional(),
  claimHome: z.string().optional(),
  claimHomeUrl: z.string().optional(),
  recordVersion: z.number().optional(),
  lockRef: z.string().optional(),
  configCommit: z.string().optional(),
});
export type Claim = z.infer<typeof claimSchema>;

export const preparedWorkspaceSchema = z.strictObject({
  path: z.string(),
  branch: z.string().optional(),
  ticket: ticketRefSchema.optional(),
});
export type PreparedWorkspace = z.infer<typeof preparedWorkspaceSchema>;

export const runSchema = z.strictObject({
  ref: runRefSchema,
  ticket: ticketRefSchema,
  harness: adapterRefSchema,
  model: z.string().optional(),
  workspace: preparedWorkspaceSchema,
  capabilities: z.partialRecord(z.enum(CAPABILITIES), z.literal(true)),
  status: z.enum([
    "planning",
    "claimed",
    "compensated",
    "collision",
    "released",
    "recovery_required",
  ]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Run = z.infer<typeof runSchema>;
