import type { z } from "zod";
import { type InputParser, inputParser } from "./parser.ts";
import { type Input, parseInput, type RawInput } from "./schema.ts";

export interface ActionView {
  readonly kind: "action";
  readonly description: string;
  readonly version: number;
  readonly aliases: readonly string[];
  readonly fields: z.ZodRawShape;
  readonly result: z.ZodType;
  readonly parser: InputParser;
  invoke(input: unknown): Promise<unknown>;
  call(input: unknown, json: boolean): Promise<{ lines: string[]; exitCode: number }>;
}
export type ActionTree = { readonly [command: string]: ActionView | ActionTree };
export function isAction(entry: ActionView | ActionTree): entry is ActionView {
  return entry.kind === "action" && typeof entry.invoke === "function";
}
export function defineAction<S extends z.ZodRawShape, R extends z.ZodType>(definition: {
  description: string;
  version?: number;
  aliases?: readonly string[];
  input: S;
  result: R;
  validate?(input: Input<S>): void;
  handler(input: Input<S>): z.input<R> | Promise<z.input<R>>;
  render?(output: z.output<R>, json: boolean): string[];
  exitCode?(output: z.output<R>): number;
}) {
  async function invoke(raw: unknown): Promise<z.output<R>> {
    const input = parseInput(definition.input, raw);
    definition.validate?.(input);
    const parsed = definition.result.safeParse(await definition.handler(input));
    if (!parsed.success)
      throw new Error(
        `Action result does not match its contract at ${parsed.error.issues[0]?.path.join(".") || "result"}`,
      );
    return parsed.data;
  }
  return {
    kind: "action" as const,
    description: definition.description,
    version: definition.version ?? 1,
    aliases: definition.aliases ?? [],
    fields: definition.input,
    result: definition.result,
    parser: inputParser(definition.input),
    invoke,
    execute(input: RawInput<S>): Promise<z.output<R>> {
      return invoke(input);
    },
    async call(input: unknown, json: boolean) {
      const output = await invoke(input);
      return {
        lines: definition.render
          ? definition.render(output, json)
          : [typeof output === "string" && !json ? output : JSON.stringify(output, null, 2)],
        exitCode: definition.exitCode?.(output) ?? 0,
      };
    },
  };
}
