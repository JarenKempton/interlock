import { bash, fish, suggestSync, zsh } from "@optique/core";
import { z } from "zod";
import type { ActionTree } from "./definition.ts";
import { commandParser } from "./parser.ts";

const shells = { bash, zsh, fish };
export const completionShellSchema = z.enum(["bash", "zsh", "fish"]);
export type CompletionShell = z.infer<typeof completionShellSchema>;
export function completionCandidates(tree: ActionTree, words: readonly string[]): string[] {
  const parser = commandParser(tree);
  const [first = "", ...rest] = [...words, ""];
  const [optionFirst = "--", ...optionRest] = [...words, "--"];
  const suggestions = [
    ...suggestSync(parser, [first, ...rest]),
    ...suggestSync(parser, [optionFirst, ...optionRest]),
  ];
  return [...new Set(suggestions.flatMap((item) => (item.kind === "literal" ? [item.text] : [])))];
}
export function completionScript(shell: CompletionShell): string {
  return `${shells[shell].generateScript("interlock", ["--complete", shell]).trimEnd()}\n`;
}
export function completeShell(
  tree: ActionTree,
  shell: string | undefined,
  words: string[],
): string {
  const selected = parseCompletionShell(shell);
  const [first = "", ...rest] = words;
  return [
    ...shells[selected].encodeSuggestions(suggestSync(commandParser(tree), [first, ...rest])),
  ].join("");
}
export function parseCompletionShell(value: string | undefined): CompletionShell {
  const parsed = completionShellSchema.safeParse(value);
  if (!parsed.success) throw new Error("completions requires one of: bash, zsh, fish");
  return parsed.data;
}
