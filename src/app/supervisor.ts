import { z } from "zod";
import { GitHubArtifactHost } from "../adapters/artifacts/github.ts";
import { GitClaimLock, heldClaim } from "../adapters/claims/git-lock.ts";
import { T3HostPort } from "../adapters/hosts/t3/port.ts";
import type { JiraTrackerAdapter } from "../adapters/trackers/jira.ts";
import { BunGitCommandExecutor } from "../adapters/workspaces/git.ts";
import { projectConfigPath } from "../configuration/files.ts";
import { readUserSettings } from "../configuration/local-settings.ts";
import { resolveSharedConfiguration, sharedConfiguration } from "../configuration/project-files.ts";
import type { ExecutionConfiguration } from "../configuration/schema.ts";
import { normalizeClaimHome } from "../domain/claim-home.ts";
import { gateEvidenceSchema } from "../domain/gate/evidence.ts";
import { laneRefSchema } from "../domain/identifiers.ts";
import type { Lane } from "../domain/lane.ts";
import type { LaneRef, RunRef } from "../domain/model.ts";
import { parseRef } from "../domain/reference.ts";
import { resolveClaimHome } from "../execution/claim-home.ts";
import { pickupEligibility } from "../execution/eligibility.ts";
import { laneService } from "../execution/lane-commands.ts";
import { signedInLaneTracker } from "../execution/lane-tracker.ts";
import {
  executionTracker,
  pickup,
  type RuntimeServices,
  withExecutionStore,
} from "../execution/pickup-runtime.ts";
import type {
  JournalEntry,
  SupervisedLane,
  SupervisorJournal,
  SupervisorPorts,
  SupervisorProject,
} from "../execution/supervisor/ports.ts";
import { StateStore } from "../persistence/state.ts";

const JOURNAL_PREFIX = "supervisor_";
const operationSchema = z.tuple([laneRefSchema, z.string()]).readonly();
const journalEntrySchema: z.ZodType<JournalEntry> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gate"), evidence: gateEvidenceSchema }),
  z.object({
    kind: z.literal("progress"),
    mark: z.object({
      fingerprint: z.string(),
      since: z.string(),
      resumes: z.number().int().nonnegative(),
    }),
  }),
  z.object({ kind: z.literal("resume_pending"), operation: operationSchema, session: z.string() }),
  z.object({ kind: z.literal("resume_settled"), operation: operationSchema, outcome: z.string() }),
]);
const LOCK_RETRIES = 40;

export function journalEntries(store: StateStore, run: RunRef): JournalEntry[] {
  return store.steps(run).flatMap((step) => {
    if (!step.state.startsWith(JOURNAL_PREFIX) || !step.receipt_json) return [];
    try {
      const entry = journalEntrySchema.safeParse(JSON.parse(step.receipt_json));
      return entry.success ? [entry.data] : [];
    } catch {
      return [];
    }
  });
}

export function laneRun(store: StateStore, lane: Lane): RunRef | undefined {
  if (lane.run || !lane.ticket) return lane.run;
  return store.listRuns().find((run) => run.ticket === lane.ticket && run.status === "claimed")
    ?.ref;
}

function runClaim(store: StateStore, run: RunRef) {
  try {
    return store.claimForRun(run);
  } catch {
    return undefined;
  }
}

export function claimedStatus(configuration: ExecutionConfiguration | undefined) {
  if (!configuration) return undefined;
  return configuration.version === 2 ? configuration.settings.claimed_status : "In Progress";
}

function repositoryPath(configuration: ExecutionConfiguration | undefined, fallback: string) {
  return configuration?.version === 2 && configuration.repository
    ? configuration.repository.path
    : fallback;
}

async function locked<T>(
  services: RuntimeServices,
  path: string,
  action: (store: StateStore) => Promise<T>,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withExecutionStore(services, path, action);
    } catch (error) {
      const busy = error instanceof Error && error.message.startsWith("Another pickup or release");
      if (!busy || attempt >= LOCK_RETRIES) throw error;
      await Bun.sleep(250);
    }
  }
}

export interface SupervisorWiring {
  services: RuntimeServices;
  statePath: string;
  explicitState: boolean;
  store: StateStore;
}

export function supervisorPorts(wiring: SupervisorWiring): SupervisorPorts {
  const { statePath, explicitState, store } = wiring;
  const services = { ...wiring.services, statePath };
  const git = services.execution?.git ?? new BunGitCommandExecutor();
  const artifacts = services.lane?.artifacts ?? new GitHubArtifactHost(git);
  const reader = services.lane?.tracker ?? signedInLaneTracker(services, store);
  const user = () => readUserSettings(statePath);
  const trackers = new Map<string, Promise<JiraTrackerAdapter>>();
  const projectTracker = (project: SupervisorProject) => {
    const ref = parseRef(project.map);
    const site = user().jira_site;
    if (!site || !ref.namespace)
      throw new Error("Jira site is unknown; run interlock config edit --set jira_site URL");
    const key = `${site}|${ref.namespace}`;
    let tracker = trackers.get(key);
    if (!tracker) {
      tracker = executionTracker(site, ref.namespace, services).then((jira) => jira.tracker);
      trackers.set(key, tracker);
    }
    return tracker;
  };
  const host = (lane: Lane) => {
    const ref = laneRun(store, lane);
    if (!ref || !lane.ticket) throw new Error(`Lane ${lane.id} has no run`);
    const run = store.run(ref);
    const binding = {
      lane: lane.id,
      ticket: lane.ticket,
      key: parseRef(lane.ticket).nativeId ?? "",
    };
    const t3 = services.execution?.t3;
    const t3Cli = user().t3_cli;
    return new T3HostPort({
      project: repositoryPath(store.getExecutionConfiguration(run.ref), run.workspace.path),
      ...(t3Cli ? { cli: t3Cli } : {}),
      ...(t3?.process ? { process: t3.process } : {}),
      ...(t3?.server ? { server: t3.server } : {}),
      lanes: () => [binding],
      branchExists: () => Promise.reject(new Error("The supervisor never launches by session")),
    });
  };
  const runFor = (id: LaneRef) => {
    const lane = store.findLane(id);
    return lane ? laneRun(store, lane) : undefined;
  };
  const runOf = (lane: LaneRef) => {
    const run = runFor(lane);
    if (!run) throw new Error(`Lane ${lane} has no run to journal on`);
    return run;
  };
  const journal: SupervisorJournal = {
    entries: (lane) => {
      const run = runFor(lane);
      return run ? journalEntries(store, run) : [];
    },
    record: (lane, entry) => store.recordStep(runOf(lane), `${JOURNAL_PREFIX}${entry.kind}`, entry),
  };
  return {
    journal,
    now: () => services.execution?.clock?.now() ?? new Date(),
    lanes: () => {
      const claimedTickets = new Set(
        store
          .listRuns()
          .filter((run) => run.status === "claimed" || run.status === "recovery_required")
          .map((run) => run.ticket),
      );
      return store.listLanes().map((lane): SupervisedLane => {
        const run = laneRun(store, lane);
        const live =
          run !== undefined ||
          lane.state !== "queued" ||
          (lane.ticket !== undefined && claimedTickets.has(lane.ticket));
        if (!run) return { lane, live };
        const claim = lane.claim ? store.claim(lane.claim) : runClaim(store, run);
        const status = claimedStatus(store.getExecutionConfiguration(run));
        return {
          lane,
          live,
          run,
          ...(claim ? { claim } : {}),
          ...(status ? { claimedStatus: status } : {}),
        };
      });
    },
    read: async (ticket) => (await reader.read(ticket)).ticket,
    remoteClaim: async ({ run, claim }) => {
      if (!run || !claim?.claimHomeUrl) return { claim: undefined, source: "unrecorded" };
      const lock = new GitClaimLock({
        repository: store.run(run).workspace.path,
        home: normalizeClaimHome(claim.claimHomeUrl),
        git,
      });
      const held = heldClaim(await lock.read(claim.ticket));
      return { claim: held?.claim, source: claim.lockRef ?? claim.claimHomeUrl };
    },
    merged: async (url) => {
      if (!artifacts.merged) throw new Error("The artifact host cannot read merge state");
      return artifacts.merged(url);
    },
    complete: (lane) =>
      locked(services, statePath, (ledger) =>
        laneService(services, ledger).complete({ lane: lane.id }),
      ),
    attention: async (lane, reason) => {
      const result = await locked(services, statePath, (ledger) =>
        laneService(services, ledger).apply(lane.id, { type: "attention", reason }),
      );
      if (!result.ok && result.refusal.code !== "invalid_transition")
        throw new Error(result.refusal.message);
    },
    frontier: async (project) => (await projectTracker(project)).list_work(project.map),
    eligible: async (project, ticket) => {
      const path = projectConfigPath(project.repository);
      const configured = resolveSharedConfiguration(path, sharedConfiguration(path, false), user());
      return pickupEligibility(reader, ticket, configured.settings.pickable_statuses);
    },
    held: async (project, ticket) => {
      const claimHome = await resolveClaimHome(project.repository, git, user().claim_home);
      const lock = new GitClaimLock({ repository: project.repository, home: claimHome.home, git });
      return heldClaim(await lock.read(ticket.ref)) !== undefined;
    },
    launch: async (project, ticket) => {
      const key = parseRef(ticket.ref).nativeId;
      if (!key) throw new Error(`Ticket ${ticket.ref} has no key`);
      const result = await pickup(services, {
        key,
        repo: project.repository,
        launch: true,
        ...(explicitState ? { state: statePath } : {}),
      });
      if (result.dryRun) throw new Error("Pickup planned without launching");
      const lane = result.session?.lane ?? store.laneForTicket(ticket.ref)?.id;
      if (!lane) throw new Error(`Pickup of ${key} recorded no lane`);
      return { lane, ...(result.session ? { session: result.session.id } : {}) };
    },
    sessions: async (lane) => {
      const port = host(lane);
      const found = await port.find({ lane: lane.id });
      return Promise.all(found.map((session) => port.read(session)));
    },
    steer: (view, operation, message) => {
      const lane = store.findLane(view.session.lane);
      if (!lane) throw new Error(`Lane ${view.session.lane} is not recorded`);
      return host(lane).steer({ operation, session: view.session, message });
    },
  };
}

export function openSupervisorStore(services: RuntimeServices, path: string): StateStore {
  return services.execution?.openStore?.(path) ?? new StateStore(path);
}
