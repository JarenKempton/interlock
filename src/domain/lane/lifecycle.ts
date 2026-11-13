import { z } from "zod";
import { type GateEvidence, gateEvidenceSchema } from "../gate/evidence.ts";
import {
  claimRefSchema,
  laneRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../refs/identifiers.ts";
import type { ClaimRef, LaneRef, RunRef, TicketRef } from "../model.ts";

const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
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

export const laneRefusalCodeSchema = z.enum([
  "claim_collision",
  "stale_version",
  "unsupported_capability",
  "ambiguous_write",
  "invalid_transition",
  "stale_evidence",
  "recovery_required",
  "gates_unmet",
  "artifact_required",
  "artifact_mismatch",
  "tracker_not_done",
  "lane_not_found",
  "workspace_unknown",
  "push_failed",
  "artifact_host_unavailable",
  "duplicate_artifact",
  "tracker_unavailable",
  "tracker_write_failed",
  "pull_request_unmerged",
]);
export type LaneRefusalCode = z.infer<typeof laneRefusalCodeSchema>;

const laneRefusalSchema = z.strictObject({ code: laneRefusalCodeSchema, message: z.string() });

const unblockedSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("known"), tickets: z.array(ticketRefSchema) }),
  z.strictObject({ state: z.literal("unknown"), reason: z.string() }),
]);
export type Unblocked = z.infer<typeof unblockedSchema>;

export function laneResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("ok", [
    z.strictObject({
      ok: z.literal(true),
      value,
      unblocked: unblockedSchema.optional(),
      receipts: z.array(gateEvidenceSchema).optional(),
    }),
    z.strictObject({ ok: z.literal(false), refusal: laneRefusalSchema }),
  ]);
}

export type LaneResult<T> =
  | {
      ok: true;
      value: T;
      unblocked?: Unblocked;
      receipts?: GateEvidence[];
    }
  | { ok: false; refusal: { code: LaneRefusalCode; message: string } };

export const laneStateSchema = z.enum([
  "implementing",
  "submitted",
  "reviewing",
  "approved",
  "merged",
  "done",
  "attention",
]);
export type LaneState = z.infer<typeof laneStateSchema>;

export const laneEvidenceSchema = z.strictObject({
  gate: z.string(),
  head: z.string(),
  url: z.string(),
});
export type LaneEvidence = z.infer<typeof laneEvidenceSchema>;

const reviewDecisionSchema = z.enum(["approved", "changes_requested"]);

export const laneVerdictRecordSchema = z.strictObject({
  head: z.string(),
  decision: reviewDecisionSchema,
  findings: z.array(z.string()).readonly(),
  round: z.number(),
});
export type LaneVerdictRecord = z.infer<typeof laneVerdictRecordSchema>;

export const laneSchema = z.strictObject({
  id: laneRefSchema,
  ticket: ticketRefSchema.optional(),
  title: z.string().optional(),
  run: runRefSchema.optional(),
  claim: claimRefSchema.optional(),
  state: laneStateSchema,
  previousState: laneStateSchema.optional(),
  attentionReason: z.string().optional(),
  artifact: z.string().optional(),
  head: z.string().optional(),
  evidence: z.array(laneEvidenceSchema).readonly(),
  verdict: laneVerdictRecordSchema.optional(),
  reviewRound: z.number(),
  maxReviewRounds: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Lane = z.infer<typeof laneSchema>;

export type LaneCommand =
  | { type: "attach"; run: RunRef; claim: ClaimRef }
  | { type: "submit"; artifact: string; head: string; evidence: readonly LaneEvidence[] }
  | { type: "begin_review" }
  | {
      type: "verdict";
      head: string;
      decision: "approved" | "changes_requested";
      findings: readonly string[];
    }
  | {
      type: "complete";
      trackerDoneVerified: boolean;
      proof?: MergeProof;
      baseMergesOnly?: boolean;
    }
  | { type: "attention"; reason: string }
  | { type: "resume" }
  | { type: "grant_round" };

export interface LaneTransition {
  lane: Lane;
  refusal?: { code: LaneRefusalCode; message: string };
}

const laneTarget = { lane: laneRefSchema };
export const laneActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("implement"), ...laneTarget }),
  z.strictObject({ kind: z.literal("submit"), ...laneTarget }),
  z.strictObject({ kind: z.literal("review"), ...laneTarget }),
  z.strictObject({ kind: z.literal("record_verdict"), ...laneTarget, head: z.string().optional() }),
  z.strictObject({ kind: z.literal("verify_done"), ...laneTarget }),
  z.strictObject({ kind: z.literal("attention"), ...laneTarget, reason: z.string().optional() }),
  z.strictObject({ kind: z.literal("none"), ...laneTarget }),
]);
export type LaneAction = z.infer<typeof laneActionSchema>;

export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

export function createLane(input: { id: LaneRef; ticket: TicketRef }, now: string): Lane {
  return {
    id: input.id,
    ticket: input.ticket,
    state: "implementing",
    evidence: [],
    reviewRound: 0,
    maxReviewRounds: DEFAULT_MAX_REVIEW_ROUNDS,
    createdAt: now,
    updatedAt: now,
  };
}

export function isUnattached(lane: Lane): boolean {
  return lane.state === "implementing" && !lane.run;
}

export function isVerdictCurrent(lane: Lane): boolean {
  return lane.verdict !== undefined && lane.verdict.head === lane.head;
}

export function isApprovedForHead(lane: Lane, head: string): boolean {
  return lane.verdict?.decision === "approved" && lane.verdict.head === head && lane.head === head;
}

export function nextLaneAction(lane: Lane): LaneAction {
  switch (lane.state) {
    case "implementing":
      return { kind: "implement", lane: lane.id };
    case "submitted":
      return { kind: "review", lane: lane.id };
    case "reviewing":
      return { kind: "record_verdict", lane: lane.id, ...(lane.head ? { head: lane.head } : {}) };
    case "approved":
    case "merged":
      return { kind: "verify_done", lane: lane.id };
    case "attention":
      return {
        kind: "attention",
        lane: lane.id,
        ...(lane.attentionReason ? { reason: lane.attentionReason } : {}),
      };
    case "done":
      return { kind: "none", lane: lane.id };
  }
}

export const REVIEW_ROUND_LIMIT = "review_round_limit";

function isAtRoundLimit(lane: Lane): boolean {
  return lane.attentionReason === REVIEW_ROUND_LIMIT && lane.reviewRound >= lane.maxReviewRounds;
}

function isResubmittable(lane: Lane): boolean {
  return lane.state === "submitted" || lane.state === "reviewing";
}

export function pushRefusal(
  lane: Lane,
  head: string,
): { code: LaneRefusalCode; message: string } | undefined {
  if (lane.state === "done")
    return { code: "invalid_transition", message: "Lane is done and cannot submit" };
  if (lane.state !== "implementing" && !isResubmittable(lane))
    return { code: "invalid_transition", message: `Cannot submit a lane in ${lane.state}` };
  if (!lane.run)
    return { code: "invalid_transition", message: "Cannot submit a lane before lane attach" };
  if (!head.trim()) return { code: "gates_unmet", message: "Submit requires a head commit" };
  if (isResubmittable(lane) && head !== lane.head && lane.reviewRound >= lane.maxReviewRounds)
    return {
      code: "gates_unmet",
      message: `Review round limit ${lane.maxReviewRounds} reached; grant one more with lane grant-round`,
    };
  return undefined;
}

function refused(lane: Lane, code: LaneRefusalCode, message: string): LaneTransition {
  return { lane, refusal: { code, message } };
}

function moved(lane: Lane, now: string, patch: Partial<Lane>): LaneTransition {
  return { lane: { ...lane, ...patch, updatedAt: now } };
}

export function transitionLane(lane: Lane, command: LaneCommand, now: string): LaneTransition {
  if (lane.state === "done")
    return refused(lane, "invalid_transition", `Lane is done and cannot ${command.type}`);
  switch (command.type) {
    case "attach": {
      if (!isUnattached(lane))
        return refused(lane, "invalid_transition", `Cannot attach a lane in ${lane.state}`);
      return moved(lane, now, { run: command.run, claim: command.claim });
    }
    case "submit": {
      const push = pushRefusal(lane, command.head);
      if (push) return refused(lane, push.code, push.message);
      if (isResubmittable(lane) && command.head === lane.head)
        return refused(
          lane,
          "invalid_transition",
          `Lane is already ${lane.state} at ${command.head}; a new round needs a new head`,
        );
      if (!command.artifact.trim())
        return refused(lane, "artifact_required", "Submit requires an artifact");
      if (lane.artifact && lane.artifact !== command.artifact)
        return refused(
          lane,
          "artifact_mismatch",
          "Lane already has a different artifact; one lane produces one artifact",
        );
      if (command.evidence.length === 0)
        return refused(lane, "gates_unmet", "Submit requires evidence for the head commit");
      if (command.evidence.some((item) => !item.gate.trim() || !item.url.trim()))
        return refused(lane, "gates_unmet", "Evidence requires a gate and a url");
      if (command.evidence.some((item) => item.head !== command.head))
        return refused(
          lane,
          "stale_evidence",
          "Evidence is bound to a different head than the submission",
        );
      const patch: Partial<Lane> = {
        state: "submitted",
        artifact: command.artifact,
        head: command.head,
        evidence: command.evidence,
        reviewRound: lane.reviewRound + 1,
      };
      const next: Lane = { ...lane, ...patch, updatedAt: now };
      delete next.verdict;
      return { lane: next };
    }
    case "begin_review": {
      if (lane.state !== "submitted")
        return refused(lane, "invalid_transition", `Cannot review a lane in ${lane.state}`);
      return moved(lane, now, { state: "reviewing" });
    }
    case "verdict": {
      if (lane.state !== "reviewing")
        return refused(lane, "invalid_transition", `Cannot record a verdict in ${lane.state}`);
      if (command.head !== lane.head)
        return refused(
          lane,
          "stale_evidence",
          "Verdict is bound to a different head than the submitted head",
        );
      if (command.decision === "changes_requested" && command.findings.length === 0)
        return refused(lane, "gates_unmet", "changes_requested requires findings");
      const verdict: LaneVerdictRecord = {
        head: command.head,
        decision: command.decision,
        findings: command.findings,
        round: lane.reviewRound,
      };
      if (command.decision === "approved") return moved(lane, now, { state: "approved", verdict });
      if (lane.reviewRound >= lane.maxReviewRounds)
        return moved(lane, now, {
          state: "attention",
          previousState: "implementing",
          attentionReason: REVIEW_ROUND_LIMIT,
          verdict,
        });
      return moved(lane, now, { state: "implementing", verdict });
    }
    case "complete": {
      if (lane.state !== "approved" && lane.state !== "merged")
        return refused(lane, "invalid_transition", `Cannot complete a lane in ${lane.state}`);
      if (!command.proof?.merged)
        return refused(lane, "pull_request_unmerged", "Completion requires a verified merge");
      const approvedHead = command.baseMergesOnly && lane.head ? lane.head : command.proof.head;
      if (!isApprovedForHead(lane, approvedHead))
        return refused(lane, "stale_evidence", "Merged head does not have the lane's approval");
      if (command.proof.url !== lane.artifact)
        return refused(lane, "artifact_mismatch", "Merge proof belongs to another pull request");
      if (!command.trackerDoneVerified)
        return refused(
          lane,
          "tracker_not_done",
          "Tracker readback has not verified the ticket is done",
        );
      return moved(lane, now, { state: "done" });
    }
    case "attention": {
      if (lane.state === "attention")
        return refused(lane, "invalid_transition", "Lane is already in attention");
      if (!command.reason.trim())
        return refused(lane, "gates_unmet", "Attention requires a reason");
      return moved(lane, now, {
        state: "attention",
        previousState: lane.state,
        attentionReason: command.reason,
      });
    }
    case "resume": {
      if (lane.state !== "attention")
        return refused(lane, "invalid_transition", `Cannot resume a lane in ${lane.state}`);
      if (isAtRoundLimit(lane))
        return refused(
          lane,
          "gates_unmet",
          `Lane is held at its review round limit ${lane.maxReviewRounds}; grant one more with lane grant-round`,
        );
      const next: Lane = {
        ...lane,
        state: lane.previousState ?? "implementing",
        updatedAt: now,
      };
      delete next.previousState;
      delete next.attentionReason;
      return { lane: next };
    }
    case "grant_round": {
      if (lane.reviewRound < lane.maxReviewRounds)
        return refused(
          lane,
          "invalid_transition",
          `Lane has used ${lane.reviewRound} of ${lane.maxReviewRounds} review rounds; grant one only at the limit`,
        );
      if (lane.state === "attention" && lane.attentionReason !== REVIEW_ROUND_LIMIT)
        return refused(
          lane,
          "invalid_transition",
          `Lane needs attention for ${lane.attentionReason ?? "another reason"}, not its round limit`,
        );
      const granted: Lane = { ...lane, maxReviewRounds: lane.reviewRound + 1, updatedAt: now };
      if (lane.state !== "attention") return { lane: granted };
      const resumed: Lane = { ...granted, state: lane.previousState ?? "implementing" };
      delete resumed.previousState;
      delete resumed.attentionReason;
      return { lane: resumed };
    }
  }
}
