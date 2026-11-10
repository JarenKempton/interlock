import { formatUsage } from "@optique/core";
import type { ActionTree, RegisteredAction } from "../app/action.ts";
import { fieldDescription } from "./input-parser.ts";
import { invocationParser } from "./parser.ts";
export function actionUsage({ command, action }: RegisteredAction): string {
  return formatUsage(command.join(" "), invocationParser(action).usage);
}
export function describeAction(entry: RegisteredAction) {
  return {
    command: entry.command,
    description: entry.action.description,
    usage: actionUsage(entry),
    input: Object.fromEntries(
      Object.entries(entry.action.fields).map(([key, schema]) => [key, fieldDescription(schema)]),
    ),
  };
}
export function composeActions<A extends ActionTree, B extends ActionTree>(
  left: A,
  right: B & Record<keyof A & keyof B, never>,
) {
  if (Object.keys(left).some((key) => Object.hasOwn(right, key)))
    throw new Error("Duplicate action registration");
  return { ...left, ...right };
}
