import { z } from "zod";
import { composeActions } from "./cli/catalog.ts";
import { completionCandidates, completionScript } from "./cli/completions.ts";
import { type ActionTree, defineAction } from "./cli/definition.ts";
import { manPage } from "./cli/manpage.ts";
import { choice, flag, optional, positional, text } from "./cli/schema.ts";
import { configurationActions } from "./configuration/commands.ts";
import { VERSION } from "./distribution/version.ts";
import { runActions } from "./execution/commands.ts";
import { McpServer } from "./mcp/server.ts";
import { SocketTransport, StdioTransport } from "./mcp/transport.ts";
import { withStore } from "./persistence/command-store.ts";
import { databasePath } from "./persistence/paths.ts";
import type { RuntimeServices } from "./runtime-services.ts";
import { signInActions } from "./sign-in/commands.ts";
import { doctorChecks, doctorConfig, doctorReportSchema, renderDoctor } from "./sign-in/doctor.ts";

export function createApplication(services: RuntimeServices = {}) {
  let tree: ActionTree;
  const core = {
    doctor: defineAction({
      description:
        "Check local state, tracker sign-in and permissions, and claim-lock push access.",
      input: { project: optional(text("Jira project key to check permissions in.", "KEY")) },
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
      description: "Serve the registered actions as MCP tools.",
      input: {
        transport: optional(choice("MCP transport.", ["stdio", "socket"] as const)),
        socket: optional(text("Local socket path for the socket transport.", "PATH")),
        lane: flag("Expose only the allowlisted lane actions; token from INTERLOCK_MCP_TOKEN."),
        allow: optional(text("Comma-separated action commands exposed in lane mode.", "LIST")),
      },
      result: z.string(),
      validate(input) {
        if (input.transport === "socket" && !input.socket)
          throw new Error("Socket transport requires a socket path");
        if (input.transport !== "socket" && input.socket)
          throw new Error("Socket path requires the socket transport");
      },
      handler: async (input) => {
        const allow = input.allow
          ?.split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        const server = new McpServer(tree, {
          lane: input.lane === true,
          ...(allow?.length ? { allow } : {}),
          ...(process.env.INTERLOCK_MCP_TOKEN ? { token: process.env.INTERLOCK_MCP_TOKEN } : {}),
        });
        if (input.transport === "socket") {
          const transport = new SocketTransport(input.socket ?? "");
          const stop = () => void transport.close();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          try {
            process.stderr.write(`interlock mcp listening on ${transport.path}\n`);
            await transport.serve(server);
          } finally {
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
            await transport.close();
          }
        } else {
          await new StdioTransport().serve(server);
        }
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
  const execution = composeActions(runActions(services), signInActions(services));
  const actions = composeActions(configuration, composeActions(execution, core));
  tree = actions;
  return actions;
}
