import { z } from "zod";
import type { RunRef, TicketRef } from "../../domain/model.ts";
import type { Tracker } from "../../domain/tracker/port.ts";
import type { StateStore } from "../../persistence/state.ts";

const LEGACY_KEY = "pendingJiraWrite";

export function journalTrackerWrite(
  store: StateStore,
  run: RunRef,
  pendingTrackerWrite: unknown,
): () => void {
  const id = store.beginWrite(run, { pendingTrackerWrite });
  return () => store.completeWrite(run, id);
}

export function journaledWrite(record: unknown): unknown {
  const parsed = z.record(z.string(), z.unknown()).safeParse(record);
  if (!parsed.success) return undefined;
  return parsed.data.pendingTrackerWrite ?? parsed.data[LEGACY_KEY];
}

export async function verifyTrackerWrite(
  tracker: Tracker,
  pending: unknown,
  ticket: TicketRef,
): Promise<void> {
  if (!tracker.verifyPendingWrite)
    throw new Error("Tracker cannot verify a journaled write; inspect run evidence");
  await tracker.verifyPendingWrite(pending, ticket);
}

export async function verifyJournaledWrite(
  store: StateStore,
  run: RunRef,
  ticket: TicketRef,
  tracker: Tracker,
): Promise<void> {
  const pending = store.pendingWrite(run);
  if (!pending) return;
  const write = journaledWrite(pending.receipt);
  if (write === undefined) throw new Error("Journaled tracker write is unreadable");
  await verifyTrackerWrite(tracker, write, ticket);
  store.completeWrite(run, pending.id);
}
