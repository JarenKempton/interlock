import { z } from "zod";
import { composeActions } from "./cli/catalog.ts";
import { completionCandidates, completionScript } from "./cli/completions.ts";
import { type ActionTree, defineAction } from "./cli/definition.ts";
import { manPage } from "./cli/manpage.ts";
import { choice, positional } from "./cli/schema.ts";
import { configurationActions } from "./configuration/commands.ts";
import { VERSION } from "./distribution/version.ts";
import { runActions } from "./execution/commands.ts";
import { withStore } from "./persistence/command-store.ts";
import { databasePath } from "./persistence/paths.ts";
import type { RuntimeServices } from "./runtime-services.ts";

export function createApplication(services: RuntimeServices = {}) {
  let tree: ActionTree;
  const core = {
    doctor: defineAction({
      description: "Check local state storage.",
      input: {},
      handler: () =>
        withStore(services, () => ({
          ok: true,
          version: VERSION,
          database: services.statePath ?? databasePath(),
        })),
    }),
    version: defineAction({
      aliases: ["--version"],
      description: "Print the embedded build version.",
      input: {},
      handler: () => VERSION,
    }),
    completions: defineAction({
      description: "Print shell completion for the registered actions.",
      input: {
        shell: positional(choice("Completion shell.", ["bash", "zsh", "fish"] as const)),
        at: z
          .string()
          .optional()
          .describe("Return completion candidates for a command prefix (empty for root).")
          .meta({ metavar: "PREFIX" }),
      },
      handler: (input): string =>
        input.at === undefined
          ? completionScript(input.shell)
          : completionCandidates(tree, input.at.split(" ").filter(Boolean)).join("\n"),
    }),
    man: defineAction({
      description: "Print the manual for the registered actions.",
      input: {},
      handler: (): string => manPage(VERSION, tree),
    }),
  };
  const configuration = configurationActions(
    services.configuration ?? {
      cwd: process.cwd(),
      ...(services.statePath ? { statePath: services.statePath } : {}),
    },
  );
  const actions = composeActions(configuration, composeActions(runActions(services), core));
  tree = actions;
  return actions;
}
