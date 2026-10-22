import type { HostSession } from "./host.ts";
import type { ClaimRef, MapRef, RunRef, Ticket, TicketRef } from "./model.ts";

export type LaneRefusalCode =
  | "claim_collision"
  | "stale_version"
  | "unsupported_capability"
  | "ambiguous_write"
  | "invalid_transition"
  | "stale_evidence"
  | "recovery_required"
  | "gates_unmet"
  | "artifact_required";

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
