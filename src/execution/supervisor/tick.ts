import { type GateEvidence, observedValue, trackerSource } from "../../domain/gate/evidence.ts";
import type { HostSessionView } from "../../domain/host/capability.ts";
import type { LaneRefusalCode, LaneState } from "../../domain/lane.ts";
import type { LaneRef, Ticket, TicketRef } from "../../domain/model.ts";
import { parseRef } from "../../domain/reference.ts";
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
const SESSION_MISS_LIMIT = 3;
const SUPERVISED_SESSIONS = new Set<LaneState>(["queued", "claimed", "implementing"]);
const RETRYABLE_REFUSALS = new Set<LaneRefusalCode>([
  "ambiguous_write",
  "artifact_host_unavailable",
  "pull_request_unmerged",
  "stale_version",
  "tracker_not_done",
  "tracker_unavailable",
  "tracker_write_failed",
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
    if (!supervised.claim) {
      await this.attention(lane, "claim_unrecorded");
      return true;
    }
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
    if (!RETRYABLE_REFUSALS.has(code)) return this.attention(lane, `completion_${code}`);
    this.report.failures.push({ lane: lane.id, step: "complete", message: `${code}: ${message}` });
  }

  async session(supervised: SupervisedLane): Promise<void> {
    const { lane } = supervised;
    if (await this.humanEdits(supervised)) return;
    const entries = this.ports.journal.entries(lane.id);
    const unsettled = unsettledResume(entries);
    if (unsettled) {
      await this.attention(lane, "resume_unconfirmed");
      this.ports.journal.record(lane.id, {
        kind: "resume_settled",
        operation: unsettled,
        outcome: "handed_to_attention",
      });
      return;
    }
    let views: readonly HostSessionView[];
    try {
      views = await this.ports.sessions(lane);
    } catch (error) {
      return this.missedSession(lane, entries, "session_unreachable", errorMessage(error));
    }
    const [view] = views;
    if (views.length !== 1 || !view)
      return this.missedSession(
        lane,
        entries,
        views.length ? "session_ambiguous" : "session_missing",
        `Host reports ${views.length} sessions for the lane`,
      );
    if (trailingMisses(entries, lane.updatedAt) > 0)
      this.ports.journal.record(lane.id, { kind: "session_seen" });
    const mark = entries.findLast(
      (entry): entry is Extract<JournalEntry, { kind: "progress" }> => entry.kind === "progress",
    )?.mark;
    const previous =
      mark && Date.parse(lane.updatedAt) <= Date.parse(mark.since) ? mark : undefined;
    const decision = stallDecision(previous, view, this.ports.now(), this.policy);
    if (decision.kind === "waiting") return;
    if (decision.kind === "attention") return this.attention(lane, decision.reason);
    if (decision.kind === "progressing") return this.mark(lane.id, decision.mark);
    const attempt = entries.filter((entry) => entry.kind === "resume_pending").length + 1;
    const operation = [lane.id, `resume:${attempt}`] as const;
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

  async missedSession(
    lane: SupervisedLane["lane"],
    entries: readonly JournalEntry[],
    reason: string,
    message: string,
  ): Promise<void> {
    const at = this.observedAt();
    this.ports.journal.record(lane.id, { kind: "session_miss", reason, at });
    if (trailingMisses(entries, lane.updatedAt) + 1 >= SESSION_MISS_LIMIT)
      return this.attention(lane, reason);
    this.report.failures.push({ lane: lane.id, step: "session", message: `${reason}: ${message}` });
  }

  mark(lane: LaneRef, mark: ProgressMark): void {
    this.ports.journal.record(lane, { kind: "progress", mark });
  }

  allowed(ticket: TicketRef): boolean {
    const key = parseRef(ticket).nativeId;
    return !this.policy.only || (key !== undefined && this.policy.only.includes(key));
  }

  async scope(): Promise<Set<TicketRef>> {
    const scope = new Set<TicketRef>();
    for (const project of this.policy.projects) {
      try {
        for (const ticket of await this.ports.frontier(project))
          if (this.allowed(ticket.ref)) scope.add(ticket.ref);
      } catch (error) {
        this.report.failures.push({ step: "scope", message: errorMessage(error) });
      }
    }
    return scope;
  }

  scoped(scope: ReadonlySet<TicketRef>): readonly SupervisedLane[] {
    return this.ports.lanes().filter(({ lane }) => lane.ticket && scope.has(lane.ticket));
  }

  async frontier(scope: ReadonlySet<TicketRef>): Promise<void> {
    const live = this.scoped(scope).filter((supervised) => supervised.live);
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
        if (ticket.state !== "open" || !this.allowed(ticket.ref)) continue;
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
        try {
          this.observe(launched.lane, {
            gate: "frontier",
            fact: "blockers_closed",
            source: trackerSource(ticket.ref),
            observed: { value: true },
            observedAt: this.observedAt(),
          });
        } catch (error) {
          this.report.failures.push({
            ticket: ticket.ref,
            step: "frontier",
            message: errorMessage(error),
          });
        }
      }
    }
  }
}

function trailingMisses(entries: readonly JournalEntry[], since: string): number {
  let misses = 0;
  for (const entry of [...entries].reverse()) {
    if (entry.kind === "session_seen" || entry.kind === "progress") break;
    if (entry.kind === "session_miss" && Date.parse(entry.at) >= Date.parse(since)) misses += 1;
  }
  return misses;
}

function unsettledResume(entries: readonly JournalEntry[]) {
  const pending = entries.findLast((entry) => entry.kind === "resume_pending");
  if (pending?.kind !== "resume_pending") return undefined;
  const key = JSON.stringify(pending.operation);
  const settled = entries.some(
    (entry) => entry.kind === "resume_settled" && JSON.stringify(entry.operation) === key,
  );
  return settled ? undefined : pending.operation;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export async function superviseTick(
  ports: SupervisorPorts,
  policy: SupervisorPolicy,
): Promise<TickReport> {
  const tick = new Tick(ports, policy);
  const scope = await tick.scope();
  for (const supervised of tick.scoped(scope)) {
    const { lane } = supervised;
    if (!lane.ticket || !supervised.run) continue;
    try {
      if (lane.state === "attention")
        tick.report.attention.push({ lane: lane.id, reason: lane.attentionReason ?? "attention" });
      else if (COMPLETABLE.has(lane.state)) await tick.complete(supervised);
      else if (supervised.recoveryRequired)
        tick.report.attention.push({ lane: lane.id, reason: "recovery_required" });
      else if (SUPERVISED_SESSIONS.has(lane.state)) await tick.session(supervised);
    } catch (error) {
      tick.report.failures.push({ lane: lane.id, step: lane.state, message: errorMessage(error) });
    }
  }
  await tick.frontier(scope);
  return tick.report;
}
