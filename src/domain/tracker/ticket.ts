import { z } from "zod";
import { actorRefSchema, mapRefSchema, ticketRefSchema } from "../refs/identifiers.ts";

export const ticketKindSchema = z.enum(["task", "research", "prototype", "decision"]);
export type TicketKind = z.infer<typeof ticketKindSchema>;

const dependencySchema = z.object({
  blocking: ticketRefSchema,
  blocked: ticketRefSchema,
  kind: z.literal("blocks"),
});
export type Dependency = z.infer<typeof dependencySchema>;

export const ticketSchema = z.object({
  ref: ticketRefSchema,
  map: mapRefSchema.optional(),
  kind: ticketKindSchema.optional(),
  state: z.enum(["open", "closed"]),
  status: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  assignee: actorRefSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(dependencySchema).optional(),
  dependents: z.array(dependencySchema).optional(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export function ticketKind(ticket: Ticket): TicketKind {
  return ticket.kind ?? "task";
}
