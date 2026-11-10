import { z } from "zod";
import { type GateEvidence, gateEvidenceSchema, observedValue } from "../domain/gate/evidence.ts";
import { type Lane, laneResultSchema, laneSchema, laneStateSchema } from "../domain/lane.ts";
import { laneRefSchema, ticketRefSchema } from "../domain/identifiers.ts";
import type { StateStore } from "../persistence/state.ts";
import { journalEntries, laneRun } from "./supervisor.ts";

export const laneStatusSchema = z.strictObject({
  lane: laneRefSchema,
  ticket: ticketRefSchema.optional(),
  state: laneStateSchema,
  needsAttention: z.boolean(),
  reason: z.string().optional(),
  artifact: z.string().optional(),
  head: z.string().optional(),
  gates: z.array(gateEvidenceSchema),
});
export type LaneStatus = z.infer<typeof laneStatusSchema>;

function completionReceipts(store: StateStore, lane: Lane): GateEvidence[] {
  if (!lane.run) return [];
  return store.steps(lane.run).flatMap((step) => {
    if (step.state !== "lane_completed" || !step.receipt_json) return [];
    const parsed = laneResultSchema(laneSchema).safeParse(JSON.parse(step.receipt_json));
    return parsed.success && parsed.data.ok && parsed.data.value.id === lane.id
      ? (parsed.data.receipts ?? [])
      : [];
  });
}

function submissionEvidence(lane: Lane): GateEvidence[] {
  return lane.evidence.map((item) => ({
    gate: item.gate,
    fact: "check_passed_at_head",
    source: { system: "ci", ref: item.url },
    observed: { value: item.head },
    observedAt: lane.updatedAt,
  }));
}

export function laneStatuses(store: StateStore): LaneStatus[] {
  return store.listLanes().map((lane) => {
    const latest = new Map<string, GateEvidence>();
    const run = laneRun(store, lane);
    const journal = run
      ? journalEntries(store, run).flatMap((entry) =>
          entry.kind === "gate" ? [entry.evidence] : [],
        )
      : [];
    for (const evidence of [
      ...submissionEvidence(lane),
      ...journal,
      ...completionReceipts(store, lane),
    ])
      latest.set(evidence.gate, evidence);
    const recovery = lane.run && store.run(lane.run).status === "recovery_required";
    const reason =
      lane.state === "attention"
        ? lane.attentionReason
        : recovery
          ? "recovery_required"
          : undefined;
    return {
      lane: lane.id,
      ...(lane.ticket ? { ticket: lane.ticket } : {}),
      state: lane.state,
      needsAttention: reason !== undefined,
      ...(reason ? { reason } : {}),
      ...(lane.artifact ? { artifact: lane.artifact } : {}),
      ...(lane.head ? { head: lane.head } : {}),
      gates: [...latest.values()],
    };
  });
}

export function renderStatus(rows: readonly LaneStatus[]): string[] {
  if (rows.length === 0) return ["No lanes recorded."];
  return rows.flatMap((row) => [
    [
      row.ticket ?? row.lane,
      row.state,
      ...(row.needsAttention ? [`needs attention: ${row.reason}`] : []),
      ...(row.artifact ? [row.artifact] : []),
    ].join("  "),
    ...row.gates.map(
      (gate) =>
        `  ${gate.gate}: ${gate.fact} = ${observedValue(gate)} (${gate.source.system} ${gate.source.ref} at ${gate.observedAt})`,
    ),
  ]);
}
