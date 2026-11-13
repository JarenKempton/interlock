import type { GateEvidence } from "../../domain/gate/evidence.ts";
import type { HostSessionView, HostSteerResult } from "../../domain/host/capability.ts";
import type { Lane, LaneResult, MergeProof } from "../../domain/lane/lifecycle.ts";
import type { Claim, LaneRef, MapRef, RunRef, Ticket, TicketRef } from "../../domain/model.ts";
import type { OperationIdentity } from "../../domain/operation/identity.ts";

export interface SupervisorProject {
  map: MapRef;
  repository: string;
}

export interface SupervisorPolicy {
  projects: readonly SupervisorProject[];
  only?: readonly string[];
  parallelism: number;
  stallAfterMs: number;
  maxResumes: number;
}

export interface SupervisedLane {
  lane: Lane;
  live: boolean;
  run?: RunRef;
  recoveryRequired?: boolean;
  claim?: Claim;
  claimedStatus?: string;
  configurationError?: string;
}

export interface ProgressMark {
  fingerprint: string;
  since: string;
  resumes: number;
}

export type JournalEntry =
  | { kind: "gate"; evidence: GateEvidence }
  | { kind: "progress"; mark: ProgressMark }
  | { kind: "resume_pending"; operation: OperationIdentity; session: string }
  | { kind: "resume_settled"; operation: OperationIdentity; outcome: string }
  | { kind: "session_miss"; reason: string; at: string }
  | { kind: "session_seen" };

export interface SupervisorJournal {
  entries(lane: LaneRef): readonly JournalEntry[];
  record(lane: LaneRef, entry: JournalEntry): void;
}

export interface RemoteClaim {
  claim: string | undefined;
  source: string;
}

export interface SupervisorPorts {
  lanes(): readonly SupervisedLane[];
  read(ticket: TicketRef): Promise<Ticket>;
  remoteClaim(lane: SupervisedLane): Promise<RemoteClaim>;
  merged(url: string): Promise<MergeProof>;
  complete(lane: Lane): Promise<LaneResult<Lane>>;
  frontier(project: SupervisorProject): Promise<readonly Ticket[]>;
  eligible(
    project: SupervisorProject,
    ticket: Ticket,
  ): Promise<"eligible" | "unavailable" | "blocked">;
  held(project: SupervisorProject, ticket: Ticket): Promise<boolean>;
  launch(project: SupervisorProject, ticket: Ticket): Promise<{ lane: LaneRef; session?: string }>;
  sessions(lane: Lane): Promise<readonly HostSessionView[]>;
  steer(
    view: HostSessionView,
    operation: OperationIdentity,
    message: string,
  ): Promise<HostSteerResult>;
  attention(lane: Lane, reason: string): Promise<void>;
  journal: SupervisorJournal;
  now(): Date;
}

export interface TickReport {
  completed: { lane: LaneRef; ticket?: TicketRef; receipts: GateEvidence[] }[];
  launched: { ticket: TicketRef; lane: LaneRef; session?: string }[];
  resumed: { lane: LaneRef; session: string }[];
  held: { lane?: LaneRef; ticket: TicketRef; reason: string }[];
  attention: { lane: LaneRef; reason: string }[];
  failures: { lane?: LaneRef; ticket?: TicketRef; step: string; message: string }[];
  evidence: { lane: LaneRef; evidence: GateEvidence }[];
}
