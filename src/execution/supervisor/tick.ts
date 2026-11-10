import { type GateEvidence, observedValue, trackerSource } from "../../domain/gate/evidence.ts";
import type { LaneRefusalCode, LaneState } from "../../domain/lane.ts";
import type { LaneRef, Ticket, TicketRef } from "../../domain/model.ts";
import { readHumanEdits } from "./holds.ts";
import type {
  JournalEntry,
  ProgressMark,
  SupervisedLane,
  SupervisorPolicy,
  SupervisorPorts,
  TickReport,
} from "./ports.ts";
import { RESUME_MESSAGE, stallDecision } from "./stall.ts";

const COMPLETABLE = new Set<LaneState>(["approved", "merged"]);
const SUPERVISED_SESSIONS = new Set<LaneState>(["claimed", "implementing"]);
const ATTENTION_REFUSALS = new Set<LaneRefusalCode>([
  "claim_collision",
  "artifact_mismatch",
  "stale_evidence",
]);

class Tick {
  readonly report: TickReport = {
    completed: [],
    launched: [],
    resumed: [],
    held: [],
    attention: [],
    failures: [],
    evidence: [],
  };

  constructor(
    readonly ports: SupervisorPorts,
    readonly policy: SupervisorPolicy,
  ) {}

  observedAt(): string {
    return this.ports.now().toISOString();
  }

  observe(lane: LaneRef, evidence: GateEvidence): void {
    this.report.evidence.push({ lane, evidence });
    const last = this.ports.journal
      .entries(lane)
      .findLast(
        (entry): entry is Extract<JournalEntry, { kind: "gate" }> =>
          entry.kind === "gate" && entry.evidence.gate === evidence.gate,
      )?.evidence;
    if (
      !last ||
      last.source.ref !== evidence.source.ref ||
      observedValue(last) !== observedValue(evidence)
    )
      this.ports.journal.record(lane, { kind: "gate", evidence });
  }

  async attention(lane: SupervisedLane["lane"], reason: string): Promise<void> {
    await this.ports.attention(lane, reason);
    this.report.attention.push({ lane: lane.id, reason });
  }

  async humanEdits(supervised: SupervisedLane): Promise<boolean> {
    const { lane } = supervised;
    const edits = await readHumanEdits(this.ports, supervised, this.observedAt());
    for (const evidence of edits.evidence) this.observe(lane.id, evidence);
    if (!edits.hold || !lane.ticket) return false;
    this.report.held.push({ lane: lane.id, ticket: lane.ticket, reason: edits.hold });
    return true;
  }

  async complete(supervised: SupervisedLane): Promise<void> {
    const { lane } = supervised;
    if (!lane.artifact) return;
    const proof = await this.ports.merged(lane.artifact);
    this.observe(lane.id, {
      gate: "merge",
      fact: "pull_request_merged",
      source: { system: "github", ref: lane.artifact },
      observed: { value: proof.merged ? (proof.commit ?? proof.head) : false },
      observedAt: this.observedAt(),
    });
    if (!proof.merged || (await this.humanEdits(supervised))) return;
    const result = await this.ports.complete(lane);
    if (result.ok) {
      const receipts = result.receipts ?? [];
      for (const receipt of receipts) this.observe(lane.id, receipt);
      this.report.completed.push({
        lane: lane.id,
        ...(lane.ticket ? { ticket: lane.ticket } : {}),
        receipts,
      });
      return;
    }
    const { code, message } = result.refusal;
    if (ATTENTION_REFUSALS.has(code)) await this.attention(lane, `completion_${code}`);
    else
      this.report.failures.push({
        lane: lane.id,
        step: "complete",
        message: `${code}: ${message}`,
      });
  }

  async session(supervised: SupervisedLane): Promise<void> {
    const { lane } = supervised;
    if (await this.humanEdits(supervised)) return;
    const entries = this.ports.journal.entries(lane.id);
    if (unsettledResume(entries)) return this.attention(lane, "resume_unconfirmed");
    const views = await this.ports.sessions(lane);
    const [view] = views;
    if (views.length !== 1 || !view) {
      this.report.failures.push({
        lane: lane.id,
        step: "session",
        message: `Host reports ${views.length} sessions for the lane`,
      });
      return;
    }
    const previous = entries.findLast(
      (entry): entry is Extract<JournalEntry, { kind: "progress" }> => entry.kind === "progress",
    )?.mark;
    const decision = stallDecision(previous, view, this.ports.now(), this.policy);
    if (decision.kind === "waiting") return;
    if (decision.kind === "attention") return this.attention(lane, decision.reason);
    if (decision.kind === "progressing") return this.mark(lane.id, decision.mark);
    const operation = [lane.id, `resume:${decision.mark.resumes}`] as const;
    const session = view.session.session;
    this.ports.journal.record(lane.id, { kind: "resume_pending", operation, session });
    let outcome: string;
    try {
      const steered = await this.ports.steer(view, operation, RESUME_MESSAGE);
      outcome = steered.state === "delivered" ? "delivered" : steered.reason;
    } catch (error) {
      outcome = errorMessage(error);
    }
    this.ports.journal.record(lane.id, { kind: "resume_settled", operation, outcome });
    if (outcome !== "delivered") return this.attention(lane, "resume_unconfirmed");
    this.mark(lane.id, decision.mark);
    this.report.resumed.push({ lane: lane.id, session });
  }

  mark(lane: LaneRef, mark: ProgressMark): void {
    this.ports.journal.record(lane, { kind: "progress", mark });
  }

  async frontier(): Promise<void> {
    const lanes = this.ports.lanes().filter(({ lane }) => lane.ticket);
    const live = lanes.filter((supervised) => supervised.live);
    const laned = new Map<TicketRef, boolean>();
    for (const { lane } of live)
      if (lane.ticket)
        laned.set(lane.ticket, (laned.get(lane.ticket) ?? true) && lane.state === "done");
    let active = live.filter(({ lane }) => lane.state !== "done").length;
    for (const project of this.policy.projects) {
      if (active >= this.policy.parallelism) return;
      let tickets: readonly Ticket[];
      try {
        tickets = await this.ports.frontier(project);
      } catch (error) {
        this.report.failures.push({ step: "frontier", message: errorMessage(error) });
        continue;
      }
      for (const ticket of [...tickets].sort((a, b) => a.order - b.order)) {
        if (active >= this.policy.parallelism) return;
        if (ticket.state !== "open") continue;
        const onlyDone = laned.get(ticket.ref);
        if (onlyDone !== undefined) {
          if (onlyDone) this.report.held.push({ ticket: ticket.ref, reason: "reopened" });
          continue;
        }
        try {
          if ((await this.ports.eligible(project, ticket)) !== "eligible") continue;
          if (await this.ports.held(project, ticket)) {
            this.report.held.push({ ticket: ticket.ref, reason: "claim_held" });
            continue;
          }
        } catch (error) {
          this.report.failures.push({
            ticket: ticket.ref,
            step: "frontier",
            message: errorMessage(error),
          });
          continue;
        }
        let launched: Awaited<ReturnType<SupervisorPorts["launch"]>>;
        try {
          launched = await this.ports.launch(project, ticket);
        } catch (error) {
          this.report.failures.push({
            ticket: ticket.ref,
            step: "launch",
            message: errorMessage(error),
          });
          return;
        }
        active += 1;
        this.report.launched.push({ ticket: ticket.ref, ...launched });
        this.observe(launched.lane, {
          gate: "frontier",
          fact: "blockers_closed",
          source: trackerSource(ticket.ref),
          observed: { value: true },
          observedAt: this.observedAt(),
        });
      }
    }
  }
}

function unsettledResume(entries: readonly JournalEntry[]): boolean {
  const pending = entries.findLast((entry) => entry.kind === "resume_pending");
  if (pending?.kind !== "resume_pending") return false;
  const key = JSON.stringify(pending.operation);
  return !entries.some(
    (entry) => entry.kind === "resume_settled" && JSON.stringify(entry.operation) === key,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export async function superviseTick(
  ports: SupervisorPorts,
  policy: SupervisorPolicy,
): Promise<TickReport> {
  const tick = new Tick(ports, policy);
  for (const supervised of ports.lanes()) {
    const { lane } = supervised;
    if (!lane.ticket || !lane.run) continue;
    try {
      if (lane.state === "attention")
        tick.report.attention.push({ lane: lane.id, reason: lane.attentionReason ?? "attention" });
      else if (COMPLETABLE.has(lane.state)) await tick.complete(supervised);
      else if (SUPERVISED_SESSIONS.has(lane.state)) await tick.session(supervised);
    } catch (error) {
      tick.report.failures.push({ lane: lane.id, step: lane.state, message: errorMessage(error) });
    }
  }
  await tick.frontier();
  return tick.report;
}
