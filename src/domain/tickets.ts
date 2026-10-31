import { z } from "zod";
import { actorRefSchema, mapRefSchema, ticketRefSchema } from "./identifiers.ts";

const dependencySchema = z.object({
  blocking: ticketRefSchema,
  blocked: ticketRefSchema,
  kind: z.literal("blocks"),
});
export const ticketSchema = z.object({
  ref: ticketRefSchema,
  map: mapRefSchema,
  kind: z.enum(["task", "research", "prototype", "decision"]),
  state: z.enum(["open", "closed"]),
  status: z.string(),
  order: z.number(),
  title: z.string().optional(),
  description: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  assignee: actorRefSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(dependencySchema).optional(),
  dependents: z.array(dependencySchema).optional(),
});
