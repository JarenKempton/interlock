import { z } from "zod";

export const reviewPolicySchema = z.discriminatedUnion("policy", [
  z.strictObject({ policy: z.literal("lenses"), lenses: z.array(z.string()).min(1) }),
  z.strictObject({ policy: z.literal("human"), source: z.literal("default") }),
]);
export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = { policy: "human", source: "default" };

export function reviewPolicy(lenses: readonly string[]): ReviewPolicy {
  return lenses.length ? { policy: "lenses", lenses: [...lenses] } : DEFAULT_REVIEW_POLICY;
}
