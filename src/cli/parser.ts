import { command, fail, map, object, option, or, type Parser, text } from "@optique/core";
import { type ActionTree, type ActionView, isAction } from "../app/action.ts";
import { inputParser } from "./input-parser.ts";

export type Invocation = {
  action: ActionView;
  input: Record<string, unknown>;
  json: boolean;
  help: boolean;
};
export type CommandParser = Parser<"sync", Invocation, unknown>;

export function transportOptions() {
  return { json: option("--json"), help: option("--help", "-h") };
}
export function invocationParser(action: ActionView, forHelp = false) {
  return object({
    input: forHelp ? inputParser(action.fields, true) : action.parser,
    ...transportOptions(),
  });
}
export function commandParser(tree: ActionTree): CommandParser {
  const branches: CommandParser[] = [];
  for (const [name, entry] of Object.entries(tree)) {
    if (!isAction(entry)) {
      const child = commandParser(entry);
      if (child.usage.length) branches.push(command(name, child));
      continue;
    }
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
