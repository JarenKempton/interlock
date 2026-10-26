import { formatDocPage, getDocPageSync, object, parseSync } from "@optique/core";
import {
  actionUsage,
  describeAction,
  type RegisteredAction,
  registeredActions,
} from "./catalog.ts";
import { completeShell } from "./completions.ts";
import { type ActionTree, type ActionView, isAction } from "./definition.ts";
import { commandParser, invocationParser, transportOptions } from "./parser.ts";

export function actionHelp(tree: ActionTree, prefix: string[] = [], json = false): string {
  if (json)
    return JSON.stringify(
      {
        actions: registeredActions(tree)
          .filter((entry) => prefix.every((part, i) => entry.command[i] === part))
          .map(describeAction),
      },
      null,
      2,
    );
  const page = getDocPageSync(commandParser(tree), prefix);
  return page
    ? formatDocPage("interlock", page, {
        colors: false,
        maxWidth: 100,
        showUsage: prefix.length > 0,
      })
    : "No actions are available.\n";
}
export function parseArguments(entry: RegisteredAction, args: string[]) {
  const result = parseSync(invocationParser(entry.action), args);
  if (!result.success) {
    // Help may omit required inputs, but still respects the parser's token boundaries.
    const help = parseSync(invocationParser(entry.action, true), args);
    if (help.success && help.value.help) return help.value;
  }
  if (!result.success)
    throw new Error(
      `${entry.command.join(" ")}: Invalid arguments. Usage: ${actionUsage(entry)}. Use --help.`,
    );
  return result.value;
}
function selectCommand(tree: ActionTree, args: string[]) {
  let node: ActionTree | ActionView = tree;
  const command: string[] = [];
  for (const word of args) {
    if (isAction(node) || word.startsWith("-")) break;
    const next: ActionTree | ActionView | undefined = Object.hasOwn(node, word)
      ? node[word]
      : undefined;
    if (!next) throw new Error("Unknown command; use --help");
    node = next;
    command.push(word);
  }
  return { node, command, args: args.slice(command.length) };
}
export async function dispatch(
  tree: ActionTree,
  args: string[],
  write: (text: string) => void,
): Promise<number> {
  // Shell generators use this transport to preserve token boundaries and shell-specific encoding.
  if (args[0] === "--complete") {
    write(completeShell(tree, args[1], args.slice(2)));
    return 0;
  }
  if (args[0] === "help" || args[0] === "-h" || args[0] === "--help")
    args = [...args.slice(1), "--help"];
  const alias = registeredActions(tree).find((entry) =>
    entry.action.aliases.includes(args[0] ?? ""),
  );
  if (alias) args = [...alias.command, ...args.slice(1)];
  const selected = selectCommand(tree, args);
  if (!isAction(selected.node)) {
    const flags = parseSync(object(transportOptions()), selected.args);
    if (!flags.success) throw new Error("Group help accepts --help and --json");
    write(actionHelp(tree, selected.command, flags.value.json));
    return 0;
  }
  const entry = { command: selected.command, action: selected.node };
  const parsed = parseArguments(entry, selected.args);
  if (parsed.help) {
    write(
      parsed.json
        ? JSON.stringify(describeAction(entry), null, 2)
        : actionHelp(tree, selected.command),
    );
    return 0;
  }
  const result = await entry.action.call(parsed.input, parsed.json);
  for (const line of result.lines) write(line);
  return result.exitCode;
}
