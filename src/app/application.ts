import { z } from "zod";
import { supervisorActions } from "./supervisor/commands.ts";
import { composeActions } from "../cli/catalog.ts";
import { dispatch } from "../cli/command-line.ts";
import { completionCandidates, completionScript } from "../cli/completions.ts";
import { type ActionTree, defineAction } from "./action.ts";
import { manPage } from "../cli/manpage.ts";
import { choice, optional, positional, text } from "../cli/schema.ts";
import { configurationActions } from "../configuration/commands.ts";
import { notifyAboutUpdate } from "../distribution/update.ts";
import { VERSION } from "../distribution/version.ts";
import { runActions } from "./pickup/commands.ts";
import { serveMcpStdio } from "../mcp/server.ts";
import { withStore } from "./command-store.ts";
import { databasePath } from "../distribution/paths.ts";
import type { RuntimeServices } from "./runtime-services.ts";
import { signInActions } from "../sign-in/commands.ts";
import { doctorChecks, doctorConfig, doctorReportSchema, renderDoctor } from "../sign-in/doctor.ts";

export function createApplication(services: RuntimeServices = {}) {
  let tree: ActionTree;
  const core = {
    doctor: defineAction({
      description:
        "Check local state, tracker sign-in and permissions, and claim-lock push access.",
      input: { project: optional(text("Tracker project key to check permissions in.", "KEY")) },
      result: doctorReportSchema,
      handler: async (input) => {
        const checks = await doctorChecks(services, input.project);
        return withStore(services, () => ({
          ok: checks.missing.length === 0,
          version: VERSION,
          database: services.statePath ?? databasePath(),
          config: doctorConfig(services),
          ...checks,
        }));
      },
      render: (output, json) =>
        json ? [JSON.stringify(output, null, 2)] : [renderDoctor(output).join("\n")],
      exitCode: (output) => (output.ok ? 0 : 1),
    }),
    version: defineAction({
      aliases: ["--version"],
      description: "Print the embedded build version.",
      input: {},
      result: z.string(),
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
      result: z.string(),
      handler: (input): string =>
        input.at === undefined
          ? completionScript(input.shell)
          : completionCandidates(tree, input.at.split(" ").filter(Boolean)).join("\n"),
    }),
    man: defineAction({
      description: "Print the manual for the registered actions.",
      input: {},
      result: z.string(),
      handler: (): string => manPage(VERSION, tree),
    }),
    mcp: defineAction({
      description: "Serve the registered actions as MCP tools over stdio.",
      input: {
        allow: optional(text("Comma-separated action commands to expose as tools.", "LIST")),
      },
      result: z.string(),
      handler: async (input) => {
        const allow = input.allow
          ?.split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        await serveMcpStdio(tree, { version: VERSION, ...(allow ? { allow } : {}) });
        return "MCP server stopped.";
      },
      render: () => [],
    }),
  };
  const configuration = configurationActions(
    services.configuration ?? {
      cwd: process.cwd(),
      ...(services.statePath ? { statePath: services.statePath } : {}),
    },
  );
  const execution = composeActions(
    composeActions(runActions(services), signInActions(services)),
    supervisorActions(services),
  );
  const actions = composeActions(configuration, composeActions(execution, core));
  tree = actions;
  return actions;
}

export { VERSION };

export async function run(
  args: string[],
  write: (text: string) => void = console.log,
  services: RuntimeServices = {},
): Promise<number> {
  return dispatch(createApplication(services), args, write);
}

export function main(args: string[]): void {
  run(args)
    .then((exitCode) => {
      process.exitCode = exitCode;
      return notifyAboutUpdate({
        currentVersion: VERSION,
        interactive: Boolean(process.stdout.isTTY && process.stderr.isTTY),
        json: args.includes("--json"),
      });
    })
    .catch((error: unknown) => {
      console.error(`interlock: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
