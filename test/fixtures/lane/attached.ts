import { createLane, type Lane, transitionLane } from "../../../src/domain/lane/lifecycle.ts";
import type { ClaimRef, LaneRef, RunRef, TicketRef } from "../../../src/domain/model.ts";
import { laneRefSchema } from "../../../src/domain/refs/identifiers.ts";

export function saveAttachedLane(
  store: { saveLane(lane: Lane): void },
  input: { ticket: TicketRef; run: RunRef; claim: ClaimRef; id?: LaneRef },
): LaneRef {
  const now = new Date().toISOString();
  const id = input.id ?? laneRefSchema.parse(`interlock-lane:${crypto.randomUUID()}`);
  const attached = transitionLane(
    createLane({ id, ticket: input.ticket }, now),
    { type: "attach", run: input.run, claim: input.claim },
    now,
  );
  if (attached.refusal) throw new Error(attached.refusal.message);
  store.saveLane(attached.lane);
  return id;
}
