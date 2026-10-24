import { formatUsage } from "@optique/core";
import { type ActionTree, type ActionView, isAction } from "./definition.ts";
import { fieldDescription, invocationParser } from "./parser.ts";
export interface RegisteredAction {
  command: string[];
  action: ActionView;
}
export function registeredActions(tree: ActionTree, prefix: string[] = []): RegisteredAction[] {
  return Object.entries(tree).flatMap(([name, entry]) => {
    const command = [...prefix, name];
    return isAction(entry) ? [{ command, action: entry }] : registeredActions(entry, command);
  });
}
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
