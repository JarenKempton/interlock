import { z } from "zod";
import { GitHubArtifactHost } from "../../adapters/github/artifact.ts";
import { GitClaimLock } from "../../adapters/git/claim-lock.ts";
import { heldClaim } from "../../domain/claim/lock.ts";
import type { ClaimLockRecord } from "../../domain/claim/lock.ts";
import { T3HostPort } from "../../adapters/hosts/t3/port.ts";
import { BunGitCommandExecutor } from "../../adapters/git/workspace.ts";
import { projectConfigPath } from "../../configuration/files.ts";
import { readUserSettings } from "../../configuration/local-settings.ts";
import {
  resolveSharedConfiguration,
  sharedConfiguration,
} from "../../configuration/project-files.ts";
import type { ResolvedConfiguration } from "../../configuration/schema.ts";
import { normalizeClaimHome } from "../../domain/claim/home.ts";
import { gateEvidenceSchema } from "../../domain/gate/evidence.ts";
import { adapterRefSchema, laneRefSchema, ticketRefSchema } from "../../domain/refs/identifiers.ts";
import { isUnattached, type Lane } from "../../domain/lane/lifecycle.ts";
import type { Claim, LaneRef, RunRef } from "../../domain/model.ts";
import { parseRef } from "../../domain/refs/parse.ts";
import { resolveClaimHome } from "../claim/home.ts";
import { pickupEligibility } from "../../execution/pickup/eligibility.ts";
import { laneService } from "../lane/commands.ts";
import { signedInLaneTracker } from "../tracker/signed-in.ts";
import { siteUnknown, trackerOf } from "../tracker/registry.ts";
import type { Tracker } from "../../domain/tracker/port.ts";
import {
  executionTracker,
  pickup,
  type RuntimeServices,
  withExecutionStore,
} from "../pickup/runtime.ts";
import type {
  JournalEntry,
  SupervisedLane,
  SupervisorJournal,
  SupervisorPorts,
  SupervisorProject,
} from "../../execution/supervisor/ports.ts";
import { StateStore } from "../../persistence/state.ts";
import { getExecutionConfiguration } from "../../configuration/store.ts";

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
  z.object({ kind: z.literal("session_miss"), reason: z.string(), at: z.string() }),
  z.object({ kind: z.literal("session_seen") }),
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
  const runs = store.listRuns().filter((run) => run.ticket === lane.ticket);
  return (
    runs.find((run) => run.status === "claimed") ??
    runs.find((run) => run.status === "recovery_required")
  )?.ref;
}

export function runNeedsRecovery(store: StateStore, run: RunRef): boolean {
  try {
    return store.run(run).status === "recovery_required";
  } catch {
    return true;
  }
}

function laneClaim(store: StateStore, lane: Lane, run: RunRef) {
  try {
    return lane.claim ? store.claim(lane.claim) : store.claimForRun(run);
  } catch {
    return undefined;
  }
}

const launchedSchema = z.object({
  evidence: z.object({
    session: z.object({
      environment: z.string(),
      host: adapterRefSchema,
      harness: adapterRefSchema,
      session: z.string().min(1),
      lane: laneRefSchema,
      ticket: ticketRefSchema,
    }),
  }),
});

function launchedSession(store: StateStore, lane: Lane, run: RunRef) {
  const step = store.steps(run).findLast((item) => item.state === "host_launched");
  if (!step?.receipt_json) return undefined;
  try {
    const parsed = launchedSchema.safeParse(JSON.parse(step.receipt_json));
    return parsed.success && parsed.data.evidence.session.lane === lane.id
      ? parsed.data.evidence.session
      : undefined;
  } catch {
    return undefined;
  }
}

function releasedByCompletion(
  store: StateStore,
  run: RunRef,
  record: ClaimLockRecord,
  claim: Claim,
) {
  return (
    record.action === "release" &&
    record.claim === claim.ref &&
    store.steps(run).some((step) => step.state === "completion_release_pending")
  );
}

export function claimedStatus(configuration: ResolvedConfiguration | undefined) {
  return configuration?.settings.claimed_status;
}

function recordedClaimedStatus(
  store: StateStore,
  run: RunRef,
): { claimedStatus?: string; configurationError?: string } {
  try {
    const status = claimedStatus(getExecutionConfiguration(store, run));
    return status ? { claimedStatus: status } : {};
  } catch (error) {
    return { configurationError: error instanceof Error ? error.message : String(error) };
  }
}

function repositoryPath(configuration: ResolvedConfiguration | undefined, fallback: string) {
  return configuration?.repository?.path ?? fallback;
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
  const trackers = new Map<string, Promise<Tracker>>();
  const projectTracker = (project: SupervisorProject) => {
    const ref = parseRef(project.map);
    const entry = trackerOf(project.map);
    if (!entry) throw new Error(`No registered tracker serves ${project.map}`);
    const site = user()[entry.setting];
    if (!site || !ref.namespace) throw siteUnknown(entry);
    const key = `${entry.name}|${site}|${ref.namespace}`;
    let tracker = trackers.get(key);
    if (!tracker) {
      tracker = executionTracker(entry, site, ref.namespace, services).then(
        (connected) => connected.tracker,
      );
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
      project: repositoryPath(getExecutionConfiguration(store, run.ref), run.workspace.path),
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
          !isUnattached(lane) ||
          (lane.ticket !== undefined && claimedTickets.has(lane.ticket));
        if (!run) return { lane, live };
        const claim = laneClaim(store, lane, run);
        const recorded = recordedClaimedStatus(store, run);
        return {
          lane,
          live,
          run,
          recoveryRequired: runNeedsRecovery(store, run),
          ...(claim ? { claim } : {}),
          ...recorded,
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
      const { record } = await lock.read(claim.ticket);
      const held =
        record && (record.action !== "release" || releasedByCompletion(store, run, record, claim));
      return {
        claim: held ? record.claim : undefined,
        source: claim.lockRef ?? claim.claimHomeUrl,
      };
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
    frontier: async (project) => {
      const tracker = await projectTracker(project);
      if (!tracker.listWork) throw new Error(`Tracker cannot list the work in ${project.map}`);
      return tracker.listWork(project.map);
    },
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
      const run = laneRun(store, lane);
      const recorded = run ? launchedSession(store, lane, run) : undefined;
      if (recorded) return [await port.read(recorded)];
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
