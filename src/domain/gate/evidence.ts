import { z } from "zod";
import { parseRef } from "../refs/parse.ts";

export const gateEvidenceSchema = z.strictObject({
  gate: z.string().min(1),
  fact: z.string().min(1),
  source: z.strictObject({ system: z.string().min(1), ref: z.string().min(1) }),
  observed: z.union([
    z.strictObject({ value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
    z.strictObject({ ref: z.string() }),
  ]),
  observedAt: z.string(),
});
export type GateEvidence = z.infer<typeof gateEvidenceSchema>;

export function trackerSource(ticket: string): GateEvidence["source"] {
  return { system: parseRef(ticket).adapter ?? "tracker", ref: ticket };
}

export function observedValue(evidence: GateEvidence): string {
  return "ref" in evidence.observed ? evidence.observed.ref : String(evidence.observed.value);
}
