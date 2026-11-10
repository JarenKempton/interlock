import type { Ticket, TicketRef } from "../../domain/model.ts";
import type { TrackerReader } from "../../domain/tracker/port.ts";

export type Eligibility = "eligible" | "unavailable" | "blocked";

export type PickableStatuses = (ticket: Ticket) => readonly string[] | undefined;

type TicketReader = Pick<TrackerReader, "read">;

export async function pickupEligibility(
  tracker: TicketReader,
  ticket: Ticket,
  pickable: readonly string[],
): Promise<Eligibility> {
  if (ticket.state !== "open" || ticket.assignee !== undefined || !pickable.includes(ticket.status))
    return "unavailable";
  for (const dependency of ticket.dependencies ?? []) {
    if ((await tracker.read(dependency.blocking)).ticket.state !== "closed") return "blocked";
  }
  return "eligible";
}

export async function unblockedBy(
  tracker: TicketReader,
  ticket: Ticket,
  pickable: PickableStatuses,
): Promise<TicketRef[]> {
  const unblocked: TicketRef[] = [];
  for (const blocked of new Set((ticket.dependents ?? []).map((edge) => edge.blocked))) {
    const candidate = (await tracker.read(blocked)).ticket;
    const statuses = pickable(candidate);
    if (statuses && (await pickupEligibility(tracker, candidate, statuses)) === "eligible")
      unblocked.push(blocked);
  }
  return unblocked;
}
