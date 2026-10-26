import { z } from "zod";
import type { ActorRef, AdapterRef, ClaimRef, MapRef, RunRef, TicketRef } from "./model.ts";

// Opaque IDs are nonempty strings. Qualified tracker syntax is separately checked by parseRef.
function identifier<T extends string>() {
  return z.custom<T>(
    (value) => typeof value === "string" && value.trim().length > 0,
    "Expected a nonempty identifier",
  );
}
export const actorRefSchema = identifier<ActorRef>();
export const adapterRefSchema = identifier<AdapterRef>();
export const ticketRefSchema = identifier<TicketRef>();
export const mapRefSchema = identifier<MapRef>();
export const runRefSchema = z.custom<RunRef>(
  (value) => typeof value === "string" && value.startsWith("interlock-run:") && value.length > 14,
  "Expected a run reference",
);
export const claimRefSchema = z.custom<ClaimRef>(
  (value) => typeof value === "string" && value.startsWith("interlock-claim:") && value.length > 16,
  "Expected a claim reference",
);
