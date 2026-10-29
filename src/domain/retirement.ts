import { z } from "zod";
import { claimRefSchema, laneRefSchema, runRefSchema, ticketRefSchema } from "./identifiers.ts";

const oid = z.string().regex(/^[a-f0-9]{40,64}$/);
export const mergeProofSchema = z.object({
  merged: z.boolean(),
  url: z.url(),
  repository: z.string().min(1),
  branch: z.string().min(1),
  head: oid,
  base: z.string().min(1),
  commit: oid.nullable(),
});
export type MergeProof = z.infer<typeof mergeProofSchema>;

export const retirementIdentitySchema = z.object({
  lane: laneRefSchema,
  run: runRefSchema,
  claim: claimRefSchema,
  ticket: ticketRefSchema,
  path: z.string().min(1),
  branch: z.string().min(1),
  head: oid,
  artifact: z.url(),
});
export type RetirementIdentity = z.infer<typeof retirementIdentitySchema>;

export const retirementPlanSchema = retirementIdentitySchema.extend({
  worktreePath: z.string().min(1),
  repositoryPath: z.string().min(1),
  commonDirectory: z.string().min(1),
  worktreeDirectory: z.string().min(1),
  worktreeIdentity: z.string().min(1),
  proof: mergeProofSchema,
  retainedRef: z.string().startsWith("refs/interlock/retired/"),
  integration: z.enum(["ancestry", "squash"]),
});
export type RetirementPlan = z.infer<typeof retirementPlanSchema>;
export const retirementPhaseSchema = z.enum(["prepared", "worktree_removed", "branch_removed"]);
export type RetirementPhase = z.infer<typeof retirementPhaseSchema>;
export interface RetirementRecord {
  plan: RetirementPlan;
  phase: RetirementPhase;
}
export interface LaneWorkspaces {
  prepare(identity: RetirementIdentity, proof: MergeProof): Promise<RetirementPlan>;
  retire(record: RetirementRecord, advance: (phase: RetirementPhase) => void): Promise<void>;
}

export class RetirementRefusal extends Error {
  constructor(
    readonly code: "workspace_dirty" | "branch_unmerged" | "workspace_unknown" | "cleanup_pending",
    message: string,
  ) {
    super(message);
  }
}
