import { type GateEvidence, observedValue, trackerSource } from "../../domain/gate/evidence.ts";
import type { HostSessionView } from "../../domain/host/capability.ts";
import {
  type Lane,
  type LaneRefusalCode,
  type LaneState,
  REVIEW_ROUND_LIMIT,
} from "../../domain/lane/lifecycle.ts";
import type { LaneRef, TicketRef } from "../../domain/model.ts";
import type { Ticket } from "../../domain/tracker/ticket.ts";
import { parseRef } from "../../domain/refs/parse.ts";
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
export const READ_MISS_LIMIT = 5;
const REASON_LIMIT = 200;

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
    reported: [],
    warnings: [],
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

  async attention(lane: Lane, reason: string): Promise<void> {
    await this.flag(await this.ports.attention(lane, reason), reason);
  }

  async flag(lane: Lane, reason: string): Promise<void> {
    this.report.attention.push({ lane: lane.id, reason });
    await this.tell(lane, `attention:${reason}:${lane.updatedAt}`, attentionMessage(lane, reason));
  }

  async tell(lane: Lane, event: string, message: string): Promise<void> {
    const thread = this.policy.orchestrator;
    if (!thread) return;
    const told = this.ports.journal
      .entries(lane.id)
      .some((entry) => entry.kind === "reported" && entry.event === event);
    if (told) return;
    try {
      await this.ports.report(thread, message);
    } catch (error) {
      this.report.failures.push({ lane: lane.id, step: "report", message: errorMessage(error) });
      return;
    }
    this.ports.journal.record(lane.id, { kind: "reported", event });
    this.report.reported.push({ lane: lane.id, event });
  }

  async readFailed(lane: Lane, step: string, message: string): Promise<void> {
    const entries = this.ports.journal.entries(lane.id);
    this.ports.journal.record(lane.id, { kind: "read_miss", step, message, at: this.observedAt() });
    if (trailing(entries, lane.updatedAt, "read_miss", "read_seen") + 1 >= READ_MISS_LIMIT)
      return this.attention(lane, `read_failing: ${step}: ${message}`.slice(0, REASON_LIMIT));
    this.report.failures.push({ lane: lane.id, step, message });
  }

  readSucceeded(lane: Lane): void {
    const entries = this.ports.journal.entries(lane.id);
    if (trailing(entries, lane.updatedAt, "read_miss", "read_seen") > 0)
      this.ports.journal.record(lane.id, { kind: "read_seen" });
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
    if (!proof.merged && lane.state === "approved" && lane.head)
      await this.tell(lane, `ready:${lane.head}`, readyMessage(lane, lane.artifact));
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
    throw new Error(`${code}: ${message}`);
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
    if (trailing(entries, lane.updatedAt, "session_miss", "session_seen") > 0)
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
    if (trailing(entries, lane.updatedAt, "session_miss", "session_seen") + 1 >= SESSION_MISS_LIMIT)
      return this.attention(lane, reason);
    this.report.failures.push({ lane: lane.id, step: "session", message: `${reason}: ${message}` });
  }

  mark(lane: LaneRef, mark: ProgressMark): void {
    this.ports.journal.record(lane, { kind: "progress", mark });
  }

  allowed(ticket: TicketRef): boolean {
    if (!this.policy.only) return true;
    const key = nativeKey(ticket);
    return key !== undefined && this.policy.only.includes(key);
  }

  async scope(): Promise<{ tickets: Set<TicketRef>; complete: boolean }> {
    const tickets = new Set<TicketRef>();
    const seen = new Set<string>();
    let complete = true;
    for (const project of this.policy.projects) {
      try {
        for (const ticket of await this.ports.frontier(project)) {
          seen.add(nativeKey(ticket.ref) ?? "");
          if (this.allowed(ticket.ref)) tickets.add(ticket.ref);
        }
      } catch (error) {
        complete = false;
        this.report.failures.push({
          step: "scope",
          message: `${project.map}: ${errorMessage(error)}; no launches this tick`,
        });
      }
    }
    if (complete)
      for (const key of this.policy.only ?? [])
        if (!seen.has(key))
          this.report.warnings.push(
            `--only ${key} is not in any map: ${this.policy.projects.map((project) => project.map).join(", ")}`,
          );
    return { tickets, complete };
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
        this.report.failures.push({
          step: "frontier",
          message: `${project.map}: ${errorMessage(error)}`,
        });
        continue;
      }
      for (const ticket of tickets) {
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

function trailing(
  entries: readonly JournalEntry[],
  since: string,
  miss: "session_miss" | "read_miss",
  seen: "session_seen" | "read_seen",
): number {
  let misses = 0;
  for (const entry of [...entries].reverse()) {
    if (entry.kind === seen || (miss === "session_miss" && entry.kind === "progress")) break;
    if (entry.kind === miss && Date.parse(entry.at) >= Date.parse(since)) misses += 1;
  }
  return misses;
}

function nativeKey(ticket: TicketRef | undefined): string | undefined {
  if (!ticket) return undefined;
  try {
    return parseRef(ticket).nativeId;
  } catch {
    return undefined;
  }
}

function readyMessage(lane: Lane, artifact: string): string {
  return [
    `🤖 ${nativeKey(lane.ticket) ?? lane.id} is approved and ready to merge`,
    `PR ${artifact}, approved head ${lane.head ?? "unknown"}`,
    "Interlock completes the lane after the merge.",
  ].join("\n");
}

function attentionMessage(lane: Lane, reason: string): string {
  const next =
    reason === REVIEW_ROUND_LIMIT
      ? `Grant a round with: interlock lane grant-round ${lane.id}`
      : `Resume after fixing it with: interlock lane resume ${lane.id}`;
  return [
    `🤖 ${nativeKey(lane.ticket) ?? lane.id} is blocked: ${reason}`,
    ...(lane.artifact ? [`PR ${lane.artifact}`] : []),
    next,
  ].join("\n");
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
  const { tickets: scope, complete } = await tick.scope();
  for (const supervised of tick.scoped(scope)) {
    const { lane } = supervised;
    if (!lane.ticket || !supervised.run) continue;
    const step = COMPLETABLE.has(lane.state) ? "complete" : lane.state;
    try {
      if (lane.state === "attention") await tick.flag(lane, lane.attentionReason ?? "attention");
      else if (COMPLETABLE.has(lane.state)) {
        if (supervised.configurationError) throw new Error(supervised.configurationError);
        await tick.complete(supervised);
      } else if (supervised.recoveryRequired) await tick.flag(lane, "recovery_required");
      else if (lane.state === "implementing") await tick.session(supervised);
      if (lane.state !== "attention") tick.readSucceeded(lane);
    } catch (error) {
      await tick
        .readFailed(lane, step, errorMessage(error))
        .catch((failure: unknown) =>
          tick.report.failures.push({ lane: lane.id, step, message: errorMessage(failure) }),
        );
    }
  }
  if (complete) await tick.frontier(scope);
  return tick.report;
}
