import { z } from "zod";
import { claimRefSchema, laneRefSchema, runRefSchema, ticketRefSchema } from "./identifiers.ts";

export const commitOidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const submissionIdentitySchema = z.strictObject({
  lane: laneRefSchema,
  run: runRefSchema,
  claim: claimRefSchema,
  ticket: ticketRefSchema.optional(),
  repository: z.string().min(1),
  branch: z.string().min(1),
});
export const submissionRecordSchema = z.strictObject({
  version: z.literal(1),
  identity: submissionIdentitySchema,
  attempt: z.uuid(),
});
export type SubmissionIdentity = z.infer<typeof submissionIdentitySchema>;
export type SubmissionRecord = z.infer<typeof submissionRecordSchema>;

export interface SubmissionAuthority {
  reserve(identity: SubmissionIdentity, workspace: string): Promise<{ mayCreate: boolean }>;
}

export class SubmissionRefusal extends Error {
  constructor(
    readonly code: "duplicate_artifact" | "recovery_required" | "claim_collision",
    message: string,
  ) {
    super(message);
  }
}

export function ticketKeyMatches(value: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(value);
}

export function sameSubmission(left: SubmissionIdentity, right: SubmissionIdentity): boolean {
  return (
    left.lane === right.lane &&
    left.run === right.run &&
    left.claim === right.claim &&
    left.ticket === right.ticket &&
    left.repository === right.repository &&
    left.branch === right.branch
  );
}
