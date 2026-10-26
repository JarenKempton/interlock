import type { z } from "zod";
import { type InputParser, inputParser } from "./parser.ts";
import { type Input, parseInput, type RawInput } from "./schema.ts";

export interface ActionView {
  readonly kind: "action";
  readonly description: string;
  readonly aliases: readonly string[];
  readonly fields: z.ZodRawShape;
  readonly parser: InputParser;
  invoke(input: unknown): Promise<unknown>;
  call(input: unknown, json: boolean): Promise<{ lines: string[]; exitCode: number }>;
}
export type ActionTree = { readonly [command: string]: ActionView | ActionTree };
export function isAction(entry: ActionView | ActionTree): entry is ActionView {
  return entry.kind === "action" && typeof entry.invoke === "function";
}
export function defineAction<S extends z.ZodRawShape, O>(definition: {
  description: string;
  aliases?: readonly string[];
  input: S;
  validate?(input: Input<S>): void;
  handler(input: Input<S>): O | Promise<O>;
  output?(value: unknown): O;
  render?(output: O, json: boolean): string[];
  exitCode?(output: O): number;
}) {
  async function invoke(raw: unknown): Promise<O> {
    const input = parseInput(definition.input, raw);
    definition.validate?.(input);
    const result = await definition.handler(input);
    return definition.output ? definition.output(result) : result;
  }
  return {
    kind: "action" as const,
    description: definition.description,
    aliases: definition.aliases ?? [],
    fields: definition.input,
    parser: inputParser(definition.input),
    invoke,
    execute(input: RawInput<S>): Promise<O> {
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
