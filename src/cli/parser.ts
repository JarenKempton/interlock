import {
  argument,
  command,
  ensureNonEmptyString,
  fail,
  map,
  message,
  object,
  option,
  optional,
  or,
  type Parser,
  seq,
  text,
} from "@optique/core";
import { zod } from "@optique/zod";
import { z } from "zod";
import { type ActionTree, type ActionView, isAction } from "./definition.ts";

export type InputParser = Parser<"sync", Record<string, unknown>, unknown>;
export type Invocation = {
  action: ActionView;
  input: Record<string, unknown>;
  json: boolean;
  help: boolean;
};
export type CommandParser = Parser<"sync", Invocation, unknown>;

function unwrap(schema: z.core.$ZodType): z.core.$ZodType {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault
  )
    return unwrap(schema.unwrap());
  if (schema instanceof z.ZodPipe) return unwrap(schema.in);
  return schema;
}
function acceptsOmission(schema: z.core.$ZodType): boolean {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault
  )
    return true;
  return schema instanceof z.ZodPipe && acceptsOmission(schema.in);
}
export function fieldDescription(schema: z.core.$ZodType): {
  description: string;
  values: string[];
  required: boolean;
  positional: boolean;
} {
  const base = unwrap(schema);
  const metadata = { ...z.globalRegistry.get(base), ...z.globalRegistry.get(schema) };
  const metavar = typeof metadata?.metavar === "string" ? metadata.metavar : "VALUE";
  return {
    description:
      schema instanceof z.ZodType
        ? (schema.description ?? metadata?.description ?? "")
        : (metadata?.description ?? ""),
    values:
      base instanceof z.ZodBoolean
        ? []
        : base instanceof z.ZodTuple
          ? base.def.items.flatMap((item) => fieldDescription(item).values)
          : [metavar],
    required: !acceptsOmission(schema),
    positional: metadata?.positional === true,
  };
}
export function inputParser(shape: z.ZodRawShape, forHelp = false): InputParser {
  const fields: Record<string, Parser<"sync", unknown, unknown>> = {};
  for (const [name, schema] of Object.entries(shape)) {
    const base = unwrap(schema);
    const info = fieldDescription(schema);
    const description = [text(info.description)];
    // Library validation errors can echo raw input; Interlock emits only schema-owned diagnostics.
    const value = (
      item: z.core.$ZodType,
      metavar = fieldDescription(item).values[0] ?? "VALUE",
    ) => {
      if (!(item instanceof z.ZodType)) throw new Error("CLI fields require a Zod schema");
      ensureNonEmptyString(metavar);
      return {
        ...zod(item, {
          placeholder: undefined,
          metavar,
          errors: { zodError: () => message`Invalid value` },
        }),
        // Preserve raw tokens until the action's single Zod validation boundary.
        // The library still supplies schema-aware suggestions and value formatting.
        parse: (input: string) => ({ success: true as const, value: input }),
      };
    };
    let parser: Parser<"sync", unknown, unknown>;
    if (info.positional) parser = argument(value(base, info.values[0]), { description });
    else if (base instanceof z.ZodBoolean) parser = option(`--${name}`, { description });
    else if (base instanceof z.ZodTuple) {
      const [first, ...rest] = base.def.items;
      if (!first) throw new Error("An option tuple must contain at least one argument");
      parser = seq(
        option(`--${name}`, value(first), { description }),
        ...rest.map((item) => argument(value(item))),
      );
    } else parser = option(`--${name}`, value(base, info.values[0]), { description });
    fields[name] = info.required && !forHelp ? parser : optional(parser);
  }
  return object(fields);
}
export function transportOptions() {
  return { json: option("--json"), help: option("--help", "-h") };
}
export function invocationParser(action: ActionView, forHelp = false) {
  return object({
    input: forHelp ? inputParser(action.fields, true) : action.parser,
    ...transportOptions(),
  });
}
export function commandParser(tree: ActionTree, includeUnavailable = false): CommandParser {
  const branches: CommandParser[] = [];
  for (const [name, entry] of Object.entries(tree)) {
    if (!isAction(entry)) {
      const child = commandParser(entry, includeUnavailable);
      if (child.usage.length) branches.push(command(name, child));
      continue;
    }
    if (!includeUnavailable && !entry.availability.available) continue;
    const parser = map(invocationParser(entry), ({ input, json, help }) => ({
      action: entry,
      input,
      json,
      help,
    }));
    branches.push(command(name, parser, { description: [text(entry.description)] }));
  }
  return branches.reduce((left, right) => or(left, right), fail<Invocation>());
}
