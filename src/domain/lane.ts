import type { HostSession } from "./host.ts";
import type { ClaimRef, LaneRef, MapRef, RunRef, Ticket, TicketRef } from "./model.ts";

export type LaneRefusalCode =
  | "claim_collision"
  | "stale_version"
  | "unsupported_capability"
  | "ambiguous_write"
  | "invalid_transition"
  | "stale_evidence"
  | "recovery_required"
  | "gates_unmet"
  | "artifact_required"
  | "artifact_mismatch"
  | "tracker_not_done"
  | "lane_not_found";

export type LaneResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: { code: LaneRefusalCode; message: string } };

export interface LaneIdentity {
  run: RunRef;
  claim: ClaimRef;
  ticket: TicketRef;
}

export interface LaneSubmission extends LaneIdentity {
  artifact: string;
  head: string;
  evidence: readonly { gate: string; head: string; url: string }[];
}

export interface LaneVerdict extends LaneIdentity {
  head: string;
  decision: "approved" | "changes_requested";
  findings: readonly string[];
}

export interface LaneProtocol {
  next(request: { map: MapRef; selection: "first_eligible" }): Promise<LaneResult<Ticket | null>>;
  attach(request: LaneIdentity & { session: HostSession }): Promise<LaneResult<LaneIdentity>>;
  submit(request: LaneSubmission): Promise<LaneResult<LaneSubmission>>;
  verdict(request: LaneVerdict): Promise<LaneResult<LaneVerdict>>;
  done(request: LaneIdentity & { head: string }): Promise<LaneResult<LaneIdentity>>;
}

export type LaneState =
  | "queued"
  | "claimed"
  | "implementing"
  | "submitted"
  | "reviewing"
  | "approved"
  | "merged"
  | "done"
  | "attention";

export interface LaneEvidence {
  gate: string;
  head: string;
  url: string;
}

export interface LaneVerdictRecord {
  head: string;
  decision: "approved" | "changes_requested";
  findings: readonly string[];
  round: number;
}

export interface Lane {
  id: LaneRef;
  ticket?: TicketRef;
  title?: string;
  run?: RunRef;
  claim?: ClaimRef;
  state: LaneState;
  previousState?: LaneState;
  attentionReason?: string;
  artifact?: string;
  head?: string;
  evidence: readonly LaneEvidence[];
  verdict?: LaneVerdictRecord;
  reviewRound: number;
  maxReviewRounds: number;
  createdAt: string;
  updatedAt: string;
}

export type LaneCommand =
  | { type: "claim"; run: RunRef; claim: ClaimRef }
  | { type: "start" }
  | { type: "submit"; artifact: string; head: string; evidence: readonly LaneEvidence[] }
  | { type: "begin_review" }
  | {
      type: "verdict";
      head: string;
      decision: "approved" | "changes_requested";
      findings: readonly string[];
    }
  | { type: "merge"; head: string }
  | { type: "complete"; trackerDoneVerified: boolean }
  | { type: "attention"; reason: string }
  | { type: "resume" }
  | { type: "promote"; ticket: TicketRef };

export interface LaneTransition {
  lane: Lane;
  refusal?: { code: LaneRefusalCode; message: string };
}

export type LaneAction =
  | { kind: "claim"; lane: LaneRef }
  | { kind: "implement"; lane: LaneRef }
  | { kind: "submit"; lane: LaneRef }
  | { kind: "review"; lane: LaneRef }
  | { kind: "record_verdict"; lane: LaneRef; head?: string }
  | { kind: "merge"; lane: LaneRef; head?: string }
  | { kind: "verify_done"; lane: LaneRef }
  | { kind: "attention"; lane: LaneRef; reason?: string }
  | { kind: "none"; lane: LaneRef };

export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

export function createLane(
  input: {
    id: LaneRef;
    ticket?: TicketRef;
    title?: string;
    maxReviewRounds?: number;
  },
  now: string,
): LaneTransition {
  const maxReviewRounds = input.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
  if (!Number.isInteger(maxReviewRounds) || maxReviewRounds < 1)
    return {
      lane: emptyLane(input, now, DEFAULT_MAX_REVIEW_ROUNDS),
      refusal: { code: "gates_unmet", message: "maxReviewRounds must be a positive integer" },
    };
  if (!input.ticket && !input.title?.trim())
    return {
      lane: emptyLane(input, now, maxReviewRounds),
      refusal: { code: "gates_unmet", message: "A lane requires a ticket or a title" },
    };
  return { lane: emptyLane(input, now, maxReviewRounds) };
}

function emptyLane(
  input: { id: LaneRef; ticket?: TicketRef; title?: string },
  now: string,
  maxReviewRounds: number,
): Lane {
  return {
    id: input.id,
    ...(input.ticket ? { ticket: input.ticket } : {}),
    ...(input.title ? { title: input.title } : {}),
    state: "queued",
    evidence: [],
    reviewRound: 0,
    maxReviewRounds,
    createdAt: now,
    updatedAt: now,
  };
}

export function isVerdictCurrent(lane: Lane): boolean {
  return lane.verdict !== undefined && lane.verdict.head === lane.head;
}

export function isApprovedForHead(lane: Lane, head: string): boolean {
  return lane.verdict?.decision === "approved" && lane.verdict.head === head && lane.head === head;
}

export function nextLaneAction(lane: Lane): LaneAction {
  switch (lane.state) {
    case "queued":
      return { kind: "claim", lane: lane.id };
    case "claimed":
      return { kind: "implement", lane: lane.id };
    case "implementing":
      return { kind: "implement", lane: lane.id };
    case "submitted":
      return { kind: "review", lane: lane.id };
    case "reviewing":
      return { kind: "record_verdict", lane: lane.id, ...(lane.head ? { head: lane.head } : {}) };
    case "approved":
      return { kind: "merge", lane: lane.id, ...(lane.head ? { head: lane.head } : {}) };
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

function refused(lane: Lane, code: LaneRefusalCode, message: string): LaneTransition {
  return { lane, refusal: { code, message } };
}

function moved(lane: Lane, now: string, patch: Partial<Lane>): LaneTransition {
  return { lane: { ...lane, ...patch, updatedAt: now } };
}

export function transitionLane(lane: Lane, command: LaneCommand, now: string): LaneTransition {
  if (lane.state === "done" && command.type !== "promote")
    return refused(lane, "invalid_transition", `Lane is done and cannot ${command.type}`);
  switch (command.type) {
    case "claim": {
      if (lane.state !== "queued")
        return refused(lane, "invalid_transition", `Cannot claim a lane in ${lane.state}`);
      return moved(lane, now, { state: "claimed", run: command.run, claim: command.claim });
    }
    case "start": {
      if (lane.state !== "claimed")
        return refused(lane, "invalid_transition", `Cannot start a lane in ${lane.state}`);
      return moved(lane, now, { state: "implementing" });
    }
    case "submit": {
      if (lane.state !== "implementing")
        return refused(lane, "invalid_transition", `Cannot submit a lane in ${lane.state}`);
      if (!command.artifact.trim())
        return refused(lane, "artifact_required", "Submit requires an artifact");
      if (lane.artifact && lane.artifact !== command.artifact)
        return refused(
          lane,
          "artifact_mismatch",
          "Lane already has a different artifact; one lane produces one artifact",
        );
      if (!command.head.trim())
        return refused(lane, "gates_unmet", "Submit requires a head commit");
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
          attentionReason: "review_round_limit",
          verdict,
        });
      return moved(lane, now, { state: "implementing", verdict });
    }
    case "merge": {
      if (lane.state !== "approved")
        return refused(lane, "invalid_transition", `Cannot merge a lane in ${lane.state}`);
      if (!isApprovedForHead(lane, command.head)) {
        const stale: Lane = { ...lane, state: "implementing", updatedAt: now };
        delete stale.verdict;
        return {
          lane: stale,
          refusal: {
            code: "stale_evidence",
            message: "Approved verdict is stale for the current head; resubmit for review",
          },
        };
      }
      return moved(lane, now, { state: "merged" });
    }
    case "complete": {
      if (lane.state !== "merged")
        return refused(lane, "invalid_transition", `Cannot complete a lane in ${lane.state}`);
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
      const next: Lane = {
        ...lane,
        state: lane.previousState ?? "queued",
        updatedAt: now,
      };
      delete next.previousState;
      delete next.attentionReason;
      return { lane: next };
    }
    case "promote": {
      if (lane.ticket) return refused(lane, "invalid_transition", "Lane already has a ticket");
      if (lane.state === "done")
        return refused(lane, "invalid_transition", "Cannot promote a done lane");
      return moved(lane, now, { ticket: command.ticket });
    }
  }
}
