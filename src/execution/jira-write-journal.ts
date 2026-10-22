import { z } from "zod";
import { type JiraTrackerAdapter, pendingJiraWriteSchema } from "../adapters/trackers/jira.ts";
import type { RunRef, TicketRef } from "../domain/model.ts";
import type { StateStore } from "../persistence/state.ts";

export function journalJiraWrite(
  store: StateStore,
  run: RunRef,
  pendingJiraWrite: z.infer<typeof pendingJiraWriteSchema>,
): () => void {
  const id = store.beginWrite(run, { pendingJiraWrite });
  return () => store.completeWrite(run, id);
}

export async function verifyJournaledJiraWrite(
  store: StateStore,
  run: RunRef,
  ticket: TicketRef,
  tracker: JiraTrackerAdapter,
): Promise<void> {
  const pending = store.pendingWrite(run);
  if (!pending) return;
  const { pendingJiraWrite } = z
    .object({ pendingJiraWrite: pendingJiraWriteSchema })
    .parse(pending.receipt);
  if (pendingJiraWrite.ticket !== ticket)
    throw new Error("Pending Jira write ticket does not match the claim");
  await tracker.verifyPendingWrite(pendingJiraWrite);
  store.completeWrite(run, pending.id);
}
