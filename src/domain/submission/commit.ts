import { z } from "zod";

export const commitOidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export function ticketKeyMatches(value: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(value);
}
