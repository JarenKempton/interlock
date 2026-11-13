import { type ActionTree, registeredActions } from "../app/action.ts";

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1)
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().join(" ") === [...right].sort().join(" ");
}

export function closestCommand(tree: ActionTree, words: readonly string[]): string | undefined {
  let best: { command: string; distance: number } | undefined;
  for (const { command } of registeredActions(tree)) {
    const attempt = words.slice(0, command.length);
    const distance = sameWords(attempt, command)
      ? 0
      : editDistance(attempt.join(" "), command.join(" "));
    if (!best || distance < best.distance) best = { command: command.join(" "), distance };
  }
  return best && best.distance <= Math.max(2, Math.floor(best.command.length / 3))
    ? best.command
    : undefined;
}

export function unknownCommand(tree: ActionTree, args: readonly string[]): Error {
  const end = args.findIndex((word) => word.startsWith("-"));
  const words = end < 0 ? args : args.slice(0, end);
  const suggestion = closestCommand(tree, words);
  return new Error(
    `Unknown command "${words.join(" ")}"; ${suggestion ? `did you mean "interlock ${suggestion}"?` : "use --help"}`,
  );
}
