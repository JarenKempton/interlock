import { z } from "zod";

const record = z.record(z.string(), z.unknown());

export function savedT3Choices(value: unknown): unknown {
  const parsed = record.safeParse(value);
  if (!parsed.success) return value;
  const result = { ...parsed.data };
  for (const [old, current] of [
    ["agent", "harness"],
    ["provider", "harness"],
    ["reviewer_agent", "reviewer_harness"],
  ] as const) {
    if (!Object.hasOwn(result, old)) continue;
    if (Object.hasOwn(result, current)) throw new Error("Conflicting saved harness choices");
    result[current] = result[old];
    delete result[old];
  }
  return result;
}

export function savedT3Configuration(value: unknown): unknown {
  const parsed = record.safeParse(value);
  if (!parsed.success) return value;
  const result = { ...parsed.data };
  for (const key of ["settings", "sources"]) {
    if (Object.hasOwn(result, key)) result[key] = savedT3Choices(result[key]);
  }
  const project = record.safeParse(result.project);
  if (project.success) {
    const next = { ...project.data };
    for (const key of ["defaults", "required", "t3"]) {
      if (Object.hasOwn(next, key)) next[key] = savedT3Choices(next[key]);
    }
    const roles = record.safeParse(next.roles);
    if (roles.success) {
      const reviewers = record.safeParse(roles.data.reviewers);
      next.roles = {
        ...roles.data,
        ...(roles.data.implementer ? { implementer: savedT3Choices(roles.data.implementer) } : {}),
        ...(reviewers.success
          ? {
              reviewers: Object.fromEntries(
                Object.entries(reviewers.data).map(([key, choice]) => [
                  key,
                  savedT3Choices(choice),
                ]),
              ),
            }
          : {}),
      };
    }
    result.project = next;
  }
  return result;
}
