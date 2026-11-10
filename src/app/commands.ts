import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { defineAction } from "../cli/definition.ts";
import { flag, optional, text } from "../cli/schema.ts";
import { readUserSettings } from "../configuration/local-settings.ts";
import { bunServiceRunner, installService, serviceDefinition } from "../distribution/service.ts";
import { RELEASE_BUILD } from "../distribution/version.ts";
import { gateEvidenceSchema } from "../domain/gate/evidence.ts";
import { laneRefSchema, mapRefSchema, ticketRefSchema } from "../domain/identifiers.ts";
import {
  executionStatePath,
  type RuntimeServices,
  withExecutionStore,
} from "../execution/pickup-runtime.ts";
import type { SupervisorPolicy, SupervisorProject } from "../execution/supervisor/ports.ts";
import { superviseTick } from "../execution/supervisor/tick.ts";
import { lockExecution } from "../persistence/execution-lock.ts";
import { laneStatusSchema, laneStatuses, renderStatus } from "./status.ts";
import { openSupervisorStore, supervisorPorts } from "./supervisor.ts";

const DEFAULTS = { parallelism: 2, stallMinutes: 30, intervalSeconds: 60, maxResumes: 2 };

const tickReportSchema = z.strictObject({
  completed: z.array(
    z.strictObject({
      lane: laneRefSchema,
      ticket: ticketRefSchema.optional(),
      receipts: z.array(gateEvidenceSchema),
    }),
  ),
  launched: z.array(
    z.strictObject({
      ticket: ticketRefSchema,
      lane: laneRefSchema,
      session: z.string().optional(),
    }),
  ),
  resumed: z.array(z.strictObject({ lane: laneRefSchema, session: z.string() })),
  held: z.array(
    z.strictObject({ lane: laneRefSchema.optional(), ticket: ticketRefSchema, reason: z.string() }),
  ),
  attention: z.array(z.strictObject({ lane: laneRefSchema, reason: z.string() })),
  failures: z.array(
    z.strictObject({
      lane: laneRefSchema.optional(),
      ticket: ticketRefSchema.optional(),
      step: z.string(),
      message: z.string(),
    }),
  ),
  evidence: z.array(z.strictObject({ lane: laneRefSchema, evidence: gateEvidenceSchema })),
});

const supervisorInput = {
  project: text("Comma-separated MAP=REPO pairs the supervisor serves.", "MAP=REPO"),
  parallelism: optional(text(`Maximum unfinished lanes (default ${DEFAULTS.parallelism}).`, "N")),
  "stall-minutes": optional(
    text(
      `Minutes without session progress before a resume (default ${DEFAULTS.stallMinutes}).`,
      "M",
    ),
  ),
  interval: optional(text(`Seconds between ticks (default ${DEFAULTS.intervalSeconds}).`, "S")),
  state: optional(text("Local execution database path.", "PATH")),
};

type SupervisorInput = {
  project: string;
  parallelism?: string | undefined;
  "stall-minutes"?: string | undefined;
  interval?: string | undefined;
  state?: string | undefined;
};

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function parseProjects(value: string, jiraSite: string | undefined): SupervisorProject[] {
  const projects = value
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const separator = pair.indexOf("=");
      const map = pair.slice(0, separator).trim();
      const repository = pair.slice(separator + 1).trim();
      if (separator < 1 || !repository) throw new Error(`Project ${pair} must be MAP=REPO`);
      if (map.includes(":"))
        return { map: mapRefSchema.parse(map), repository: resolve(repository) };
      if (!/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(map))
        throw new Error(`Map ${map} is not a Jira key`);
      if (!jiraSite)
        throw new Error("Jira site is unknown; run interlock config edit --set jira_site URL");
      const instance = new URL(jiraSite).hostname.replace(/\.atlassian\.net$/, "");
      const namespace = map.slice(0, map.lastIndexOf("-"));
      return {
        map: mapRefSchema.parse(`jira:${instance}:${namespace}:map:${map}`),
        repository: resolve(repository),
      };
    });
  if (projects.length === 0) throw new Error("The supervisor needs at least one MAP=REPO project");
  return projects;
}

function policyFrom(input: SupervisorInput, statePath: string): SupervisorPolicy {
  return {
    projects: parseProjects(input.project, readUserSettings(statePath).jira_site),
    parallelism: positiveInteger(input.parallelism, DEFAULTS.parallelism, "parallelism"),
    stallAfterMs:
      positiveInteger(input["stall-minutes"], DEFAULTS.stallMinutes, "stall-minutes") * 60_000,
    maxResumes: DEFAULTS.maxResumes,
  };
}

async function tickOnce(services: RuntimeServices, input: SupervisorInput, statePath: string) {
  const policy = policyFrom(input, statePath);
  const store = openSupervisorStore(services, statePath);
  try {
    return await superviseTick(
      supervisorPorts({ services, statePath, explicitState: input.state !== undefined, store }),
      policy,
    );
  } finally {
    store.close();
  }
}

function summary(report: z.infer<typeof tickReportSchema>): string {
  return JSON.stringify({
    at: new Date().toISOString(),
    completed: report.completed.map((item) => item.ticket ?? item.lane),
    launched: report.launched.map((item) => item.ticket),
    resumed: report.resumed.map((item) => item.lane),
    held: report.held,
    attention: report.attention,
    failures: report.failures,
  });
}

export function supervisorActions(services: RuntimeServices) {
  return {
    run: defineAction({
      description:
        "Supervise this environment: complete merged lanes, resume stalled sessions and launch unblocked frontier tickets, each tick.",
      input: { ...supervisorInput, once: flag("Run one tick and print its report.") },
      result: z.union([tickReportSchema, z.string()]),
      handler: async (input) => {
        const statePath = executionStatePath(services, input.state);
        policyFrom(input, statePath);
        await withExecutionStore(services, statePath, async () => undefined);
        const unlock = lockExecution(statePath, "supervisor");
        try {
          if (input.once) return await tickOnce(services, input, statePath);
          const interval =
            positiveInteger(input.interval, DEFAULTS.intervalSeconds, "interval") * 1000;
          let stopping = false;
          let wake: (() => void) | undefined;
          const stop = () => {
            stopping = true;
            wake?.();
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          try {
            while (!stopping) {
              try {
                process.stderr.write(`${summary(await tickOnce(services, input, statePath))}\n`);
              } catch (error) {
                process.stderr.write(
                  `${JSON.stringify({ at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) })}\n`,
                );
              }
              if (stopping) break;
              await new Promise<void>((done) => {
                wake = done;
                setTimeout(done, interval);
              });
            }
          } finally {
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
          }
          return "Supervisor stopped.";
        } finally {
          unlock();
        }
      },
      render: (output, json) =>
        typeof output === "string"
          ? [output]
          : json
            ? [JSON.stringify(output, null, 2)]
            : [summary(output)],
    }),
    status: defineAction({
      description: "Show each lane's state, attention need and gate evidence.",
      input: { state: optional(text("Local execution database path.", "PATH")) },
      result: z.array(laneStatusSchema),
      handler: async (input) => {
        const statePath = executionStatePath(services, input.state);
        const store = openSupervisorStore(services, statePath);
        try {
          return laneStatuses(store);
        } finally {
          store.close();
        }
      },
      render: (output, json) => (json ? [JSON.stringify(output, null, 2)] : renderStatus(output)),
    }),
    service: {
      install: defineAction({
        description:
          "Install the supervisor as a user service (systemd or launchd) that starts on boot and restarts on failure.",
        input: {
          ...supervisorInput,
          "dry-run": flag("Print the service definition without writing or activating it."),
        },
        result: z.strictObject({
          manager: z.enum(["systemd", "launchd"]),
          path: z.string(),
          content: z.string(),
          activate: z.array(z.string()),
          installed: z.boolean(),
        }),
        handler: async (input) => {
          const statePath = executionStatePath(services, input.state);
          policyFrom(input, statePath);
          const options = [
            "--project",
            input.project,
            ...(input.parallelism ? ["--parallelism", input.parallelism] : []),
            ...(input["stall-minutes"] ? ["--stall-minutes", input["stall-minutes"]] : []),
            ...(input.interval ? ["--interval", input.interval] : []),
            ...(input.state ? ["--state", resolve(input.state)] : []),
          ];
          const command = RELEASE_BUILD
            ? [process.execPath, "run", ...options]
            : [process.execPath, resolve(import.meta.dir, "../cli.ts"), "run", ...options];
          const definition = serviceDefinition(command, {
            platform: process.platform,
            home: homedir(),
            uid: process.getuid?.() ?? 0,
            logDirectory: dirname(statePath),
          });
          if (!input["dry-run"]) await installService(definition, bunServiceRunner);
          return {
            manager: definition.manager,
            path: definition.path,
            content: definition.content,
            activate: definition.activate.map((argv) => argv.join(" ")),
            installed: !input["dry-run"],
          };
        },
        render: (output, json) =>
          json
            ? [JSON.stringify(output, null, 2)]
            : [
                `${output.installed ? "Installed" : "Would install"} ${output.manager} service at ${output.path}`,
                output.content,
                ...output.activate.map(
                  (command) => `${output.installed ? "ran" : "would run"}: ${command}`,
                ),
              ],
      }),
    },
  };
}
