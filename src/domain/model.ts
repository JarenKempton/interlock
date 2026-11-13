import { z } from "zod";
import {
  actorRefSchema,
  adapterRefSchema,
  claimRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "./refs/identifiers.ts";

export type MapRef = string & { readonly __kind: "MapRef" };
export type TicketRef = string & { readonly __kind: "TicketRef" };
export type RunRef = `interlock-run:${string}`;
export type ClaimRef = `interlock-claim:${string}`;
export type LaneRef = `interlock-lane:${string}`;
export type ActorRef = string & { readonly __kind: "ActorRef" };
export type AdapterRef = string & { readonly __kind: "AdapterRef" };

export interface RepositorySpec {
  name: string;
  remote: string;
  path: string;
  worktreeRoot: string;
  baseBranch: string;
}

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
  host: adapterRefSchema,
  harness: adapterRefSchema,
  model: z.string().optional(),
  workspace: preparedWorkspaceSchema,
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
