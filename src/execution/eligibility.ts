import type { MapRef, Ticket, TicketRef } from "../domain/model.ts";
import type { TrackerReader } from "../domain/tracker.ts";

export type Eligibility = "eligible" | "unavailable" | "blocked";

export type AvailableStatuses = (map: MapRef) => readonly string[] | undefined;

export async function pickupEligibility(
  tracker: TrackerReader,
  ticket: Ticket,
  availableStatuses: AvailableStatuses,
): Promise<Eligibility> {
  const statuses = availableStatuses(ticket.map);
  if (
    !statuses ||
    ticket.state !== "open" ||
    ticket.assignee !== undefined ||
    !statuses.includes(ticket.status)
  )
    return "unavailable";
  for (const dependency of ticket.dependencies ?? []) {
    if ((await tracker.read(dependency.blocking)).ticket.state !== "closed") return "blocked";
  }
  return "eligible";
}

export async function unblockedBy(
  tracker: TrackerReader,
  ticket: Ticket,
  availableStatuses: AvailableStatuses,
): Promise<TicketRef[]> {
  const unblocked: TicketRef[] = [];
  for (const blocked of new Set((ticket.dependents ?? []).map((edge) => edge.blocked))) {
    const candidate = (await tracker.read(blocked)).ticket;
    if ((await pickupEligibility(tracker, candidate, availableStatuses)) === "eligible")
      unblocked.push(blocked);
  }
  return unblocked;
}
