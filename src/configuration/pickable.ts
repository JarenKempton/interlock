import type { PickableStatuses } from "../domain/tracker/port.ts";
import type { ResolvedConfiguration } from "./schema.ts";

export function configuredPickable(configuration: ResolvedConfiguration): PickableStatuses {
  return () => configuration.settings.pickable_statuses;
}
