import type { PickableStatuses } from "../domain/tracker/port.ts";
import { parseRef } from "../domain/refs/parse.ts";
import type { ExecutionConfiguration } from "./schema.ts";

export function configuredPickable(configuration: ExecutionConfiguration): PickableStatuses {
  if (configuration.version === 2) return () => configuration.settings.pickable_statuses;
  const { maps } = configuration.project;
  return (ticket) =>
    ticket.map ? maps[parseRef(ticket.map).nativeId ?? ""]?.available_statuses : undefined;
}
