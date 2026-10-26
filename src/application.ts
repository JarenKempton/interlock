import { z } from "zod";
import { composeActions } from "./cli/catalog.ts";
import { completionCandidates, completionScript } from "./cli/completions.ts";
import { type ActionTree, defineAction } from "./cli/definition.ts";
import { manPage } from "./cli/manpage.ts";
import { choice, optional, positional, text } from "./cli/schema.ts";
import { configurationActions } from "./configuration/commands.ts";
import { VERSION } from "./distribution/version.ts";
import { runActions } from "./execution/commands.ts";
import { withStore } from "./persistence/command-store.ts";
import { databasePath } from "./persistence/paths.ts";
import type { RuntimeServices } from "./runtime-services.ts";
import { signInActions } from "./sign-in/commands.ts";
import { doctorChecks, renderDoctor } from "./sign-in/doctor.ts";

export function createApplication(services: RuntimeServices = {}) {
  let tree: ActionTree;
  const core = {
    doctor: defineAction({
      description:
        "Check local state, tracker sign-in and permissions, and claim-lock push access.",
      input: { project: optional(text("Jira project key to check permissions in.", "KEY")) },
      handler: async (input) => {
        const checks = await doctorChecks(services, input.project);
        return withStore(services, () => ({
          ok: checks.missing.length === 0,
          version: VERSION,
          database: services.statePath ?? databasePath(),
          ...checks,
        }));
      },
      render: (output, json) =>
        json ? [JSON.stringify(output, null, 2)] : [renderDoctor(output).join("\n")],
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
  const execution = composeActions(runActions(services), signInActions(services));
  const actions = composeActions(configuration, composeActions(execution, core));
  tree = actions;
  return actions;
}
