import { z } from "zod";

export const nonemptyText = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 &&
      ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
export const text = (description: string, metavar = "VALUE") =>
  nonemptyText.describe(description).meta({ metavar });
export const optional = <S extends z.ZodType>(schema: S) => schema.optional();
export const positional = <S extends z.ZodType>(schema: S) =>
  schema.meta({ ...schema.meta(), positional: true });
export const flag = (description: string) => z.boolean().optional().describe(description);
export const choice = <const T extends readonly string[]>(description: string, values: T) =>
  z
    .enum(values)
    .describe(description)
    .meta({ metavar: values.join("|") });
export type RawInput<S extends z.ZodRawShape> = z.input<z.ZodObject<S>>;
export type Input<S extends z.ZodRawShape> = z.output<z.ZodObject<S>>;

export function parseInput<S extends z.ZodRawShape>(fields: S, raw: unknown): Input<S> {
  const result = z.strictObject(fields).safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  if (issue?.code === "unrecognized_keys") throw new Error("Unknown action input field");
  // Error paths and values from callers are not safe to echo. Only schema-owned keys are shown.
  const key = issue?.path[0];
  throw new Error(
    typeof key === "string" && Object.hasOwn(fields, key)
      ? `Invalid ${key}`
      : "Invalid action input",
  );
}
