import { t3Target } from "../../adapters/hosts/t3/catalog.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { GitClaimLock } from "../../adapters/git/claim-lock.ts";
import { heldClaim } from "../../domain/claim/lock.ts";
import type { T3Process } from "../../adapters/hosts/t3/cli.ts";
import { type T3LaneBinding, type T3LaunchPlan, T3HostPort } from "../../adapters/hosts/t3/port.ts";
import {
  BunGitCommandExecutor,
  type GitCommandExecutor,
  GitWorkspaceAdapter,
  gitWorkspaceFileSystem,
} from "../../adapters/git/workspace.ts";
import { loadConfigurationInstructions, projectConfigPath } from "../../configuration/files.ts";
import { readUserSettings } from "../../configuration/local-settings.ts";
import {
  resolveSharedConfiguration,
  sharedConfiguration,
} from "../../configuration/project-files.ts";
import {
  REVIEWER_CHOICE_KEYS,
  type ResolvedConfiguration,
  reviewChoicesFrom,
  type UserSettings,
} from "../../configuration/schema.ts";
import { selfCommand } from "../../distribution/version.ts";
import type { ClaimHome } from "../../domain/claim/home.ts";
import { CLAIM_RECORD_VERSION } from "../../domain/claim/lock.ts";
import type { Clock, Ledger } from "../../domain/contracts.ts";
import { reviewPolicy, reviewPolicySchema } from "../../domain/gate/review.ts";
import { HostRefusal } from "../../domain/host/capability.ts";
import {
  adapterRefSchema,
  claimRefSchema,
  laneRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../../domain/refs/identifiers.ts";
import { createLane, isUnattached } from "../../domain/lane/lifecycle.ts";
import type { RepositorySpec, RunRef } from "../../domain/model.ts";
import { type Ticket, ticketKind } from "../../domain/tracker/ticket.ts";
import { ticketKeyMatches } from "../../domain/submission/commit.ts";
import { lockExecution } from "../../persistence/execution-lock.ts";
import { databasePath } from "../../distribution/paths.ts";
import { StateStore } from "../../persistence/state.ts";
import type { RuntimeServices } from "../runtime-services.ts";

export type { RuntimeServices };
import { CHANGE_CLAIM_HOME, resolveClaimHome } from "../claim/home.ts";
import { ClaimCoordinator } from "../../execution/claim/coordinator.ts";
import { pickupEligibility } from "../../execution/pickup/eligibility.ts";
import { journalTrackerWrite } from "../tracker/write-journal.ts";
import {
  configuredTracker,
  type RegisteredTracker,
  siteUnknown,
  type TrackerTransports,
  ticketRef,
} from "../tracker/registry.ts";
import type { Tracker } from "../../domain/tracker/port.ts";
import { buildLaunchPrompt } from "../../execution/pickup/launch-prompt.ts";
import { PickupCoordinator } from "../../execution/pickup/coordinator.ts";
import { HostLaunchWorkspace } from "../../execution/pickup/host-launch.ts";
import {
  planHostLaunchModels,
  planT3Models,
  validateT3Catalog,
} from "../../adapters/hosts/t3/plan.ts";
import {
  getExecutionConfiguration,
  saveClaimHomeIfAbsent,
  saveExecutionConfiguration,
} from "../../configuration/store.ts";

const modelSelectionSchema = z.strictObject({
  harness: z.string(),
  instanceId: z.string(),
  model: z.string(),
  options: z.record(z.string(), z.union([z.string(), z.boolean()])),
});

const pickupPlanSchema = z.strictObject({
  version: z.literal(1),
  repository: z.string(),
  ticket: ticketRefSchema,
  worktree: z.string(),
  branch: z.string(),
  title: z.string(),
  modelSelection: modelSelectionSchema.optional(),
  reviewers: z.record(z.string(), modelSelectionSchema),
  review: reviewPolicySchema,
  prompt: z.string(),
  hostVerification: z.union([
    z.strictObject({ source: z.literal("host-defaults"), message: z.string() }),
    z.strictObject({
      source: z.literal("caller-supplied-t3-catalog"),
      observedAt: z.string(),
      sessionId: z.string(),
    }),
  ]),
  instructions: z.array(
    z.strictObject({ path: z.string(), resolvedPath: z.string(), version: z.string() }),
  ),
  claimHome: z.strictObject({
    home: z.string(),
    url: z.string(),
    source: z.string(),
    change: z.string(),
    lockRef: z.string(),
    recordVersion: z.number(),
    configCommit: z.string(),
  }),
  launch: z.strictObject({
    title: z.string(),
    message: z.string(),
    modelSelection: modelSelectionSchema.optional(),
    runtimeMode: z.string().optional(),
    interactionMode: z.string().optional(),
    workspaceStrategy: z.strictObject({
      type: z.literal("existing_worktree"),
      worktreePath: z.string(),
      branch: z.string(),
    }),
  }),
});
type PickupPlan = z.infer<typeof pickupPlanSchema>;

export const pickupResultSchema = z.discriminatedUnion("dryRun", [
  pickupPlanSchema.extend({ dryRun: z.literal(true), state: z.literal("planned") }),
  pickupPlanSchema.extend({
    dryRun: z.literal(false),
    state: z.literal("claimed"),
    run: runRefSchema,
    claim: claimRefSchema,
    claimHomeSaved: z.boolean(),
    session: z
      .strictObject({
        id: z.string(),
        lane: laneRefSchema,
        link: z.string().optional(),
        environment: z.string(),
        harness: z.string(),
        worktree: z.string(),
        branch: z.string(),
      })
      .optional(),
  }),
]);
export type PickupResult = z.infer<typeof pickupResultSchema>;

export interface ExecutionPlatform extends TrackerTransports {
  git?: GitCommandExecutor;
  clock?: Clock;
  openStore?: (path: string) => StateStore;
  t3?: {
    process?: T3Process;
    server?: () => Promise<unknown>;
    sleep?: (ms: number) => Promise<void>;
  };
}

export interface PickupInput {
  key: string;
  config?: string | undefined;
  repo?: string | undefined;
  branch?: string | undefined;
  state?: string | undefined;
  t3Catalog?: string | undefined;
  dryRun?: boolean | undefined;
  launch?: boolean | undefined;
}

export class PickupRefusal extends Error {
  constructor(
    readonly code: "reviewers_unset",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

function requireReviewersForReviewerChoices(user: UserSettings) {
  if (user.reviewers) return;
  const chosen = REVIEWER_CHOICE_KEYS.filter((key) => user[key] !== undefined);
  if (chosen.length)
    throw new PickupRefusal(
      "reviewers_unset",
      `${chosen.join(", ")} ${chosen.length > 1 ? "are" : "is"} set but reviewers is empty, so no review would run; set reviewers with interlock config edit --set reviewers LENSES or clear each with --follow KEY`,
    );
}

export function executionStatePath(services: RuntimeServices, state?: string): string {
  return state ?? services.statePath ?? services.configuration?.statePath ?? databasePath();
}

export async function withExecutionStore<T>(
  services: RuntimeServices,
  path: string,
  action: (store: StateStore) => Promise<T>,
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const store = services.execution?.openStore?.(path) ?? new StateStore(path);
  try {
    const unlock = lockExecution(path);
    try {
      return await action(store);
    } finally {
      unlock();
    }
  } finally {
    store.close();
  }
}

export function executionTarget(configuration: ResolvedConfiguration) {
  const { repository, settings } = configuration;
  const { site } = configuredTracker(settings);
  if (!repository || !site)
    throw new Error("Recorded execution configuration has no repository or tracker site");
  return { repository, site, claimedStatus: settings.claimed_status };
}

async function branchKnown(git: GitCommandExecutor, cwd: string, branch: string) {
  const local = await git.run(
    ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    cwd,
  );
  if (local.exitCode === 0) return true;
  const remote = await git.run(
    ["git", "ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
    cwd,
  );
  if (remote.exitCode === 0) return true;
  if (remote.exitCode === 2) return false;
  throw new Error(`Cannot read origin branches: ${remote.stderr.trim()}`);
}

async function gitOutput(git: GitCommandExecutor, argv: readonly string[], cwd: string) {
  const result = await git.run(argv, cwd);
  if (result.exitCode !== 0)
    throw new Error(`Git command failed (${result.exitCode}): ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function mainCheckout(git: GitCommandExecutor, directory: string) {
  const [topLevel, commonDirectory] = (
    await gitOutput(
      git,
      ["git", "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      directory,
    )
  )
    .split(/\r?\n/)
    .map((line) => resolve(line));
  if (!topLevel || !commonDirectory) throw new Error("Work repo is not a Git checkout");
  return basename(commonDirectory) === ".git" ? dirname(commonDirectory) : topLevel;
}

export async function executionTracker(
  entry: RegisteredTracker,
  site: string,
  namespace: string,
  services: RuntimeServices,
) {
  const connection = await entry.connect(services, site, namespace);
  return { connection, tracker: connection.tracker(), owner: await connection.owner() };
}

export function claimCoordination(
  repository: RepositorySpec,
  tracker: Tracker,
  services: RuntimeServices,
  home: ClaimHome,
  beforeClaimWrite?: () => void,
) {
  const claimLock = new GitClaimLock({
    repository: repository.path,
    home,
    ...(beforeClaimWrite ? { beforeClaimWrite } : {}),
    ...(services.execution?.git ? { git: services.execution.git } : {}),
    ...(services.execution?.clock ? { clock: services.execution.clock } : {}),
  });
  return { claimLock, claims: new ClaimCoordinator(claimLock, tracker) };
}

export async function pickup(services: RuntimeServices, input: PickupInput) {
  const cwd = services.configuration?.cwd ?? process.cwd();
  const statePath = executionStatePath(services, input.state);
  const git = services.execution?.git ?? new BunGitCommandExecutor();
  const repositoryPath = await mainCheckout(git, resolve(cwd, input.repo ?? "."));
  const configPath = projectConfigPath(
    input.config ? cwd : repositoryPath,
    input.config ?? "interlock.toml",
  );
  const user = readUserSettings(statePath);
  requireReviewersForReviewerChoices(user);
  const configuration = resolveSharedConfiguration(
    configPath,
    sharedConfiguration(configPath, input.config !== undefined),
    user,
  );
  const { settings } = configuration;
  const { entry, site } = configuredTracker(settings);
  const namespace = entry.namespace(input.key);
  if (!namespace) throw new Error(`Pickup requires a canonical ${entry.label} key`);
  if (!site) throw siteUnknown(entry);
  const branch = input.branch ?? settings.branch.replaceAll("{key}", input.key);
  if (!ticketKeyMatches(branch, input.key))
    throw new Error(`Branch ${branch} must contain ${input.key}`);
  if (
    (await git.run(["git", "check-ref-format", "--branch", branch], repositoryPath)).exitCode !== 0
  )
    throw new Error(`Branch ${branch} is not a valid Git branch name`);
  const rawCatalog: unknown =
    input.t3Catalog === undefined
      ? undefined
      : JSON.parse(
          input.t3Catalog === "-"
            ? await Bun.stdin.text()
            : readFileSync(resolve(cwd, input.t3Catalog), "utf8"),
        );
  const clock = services.execution?.clock ?? { now: () => new Date() };
  const verifyCatalog = () =>
    rawCatalog === undefined ? undefined : validateT3Catalog(rawCatalog, clock.now());
  const catalog = verifyCatalog();
  const models =
    input.launch && !catalog
      ? planHostLaunchModels(configuration, reviewChoicesFrom(user))
      : planT3Models(configuration, catalog, reviewChoicesFrom(user));
  const tracker = await executionTracker(entry, site, namespace, services);
  const ref = ticketRef(entry, tracker.connection.instance, input.key);
  const ticket = (await tracker.tracker.read(ref)).ticket;
  const pickable = settings.pickable_statuses;
  const eligible = async (current: Ticket) => {
    const eligibility = await pickupEligibility(tracker.tracker, current, pickable);
    if (eligibility === "unavailable")
      throw new Error(
        `Ticket is not available; pickup needs an open, unassigned ticket in ${pickable.join(", ")}`,
      );
    const planned = (value: Ticket) => JSON.stringify({ ...value, dependents: undefined });
    if (planned(current) !== planned(ticket))
      throw new Error("Ticket changed during planning; retry pickup");
    if (eligibility === "blocked")
      throw new Error("Ticket is not available; unfinished dependencies block pickup");
  };
  await eligible(ticket);
  const claimHome = await resolveClaimHome(repositoryPath, git, user.claim_home);
  const repository: RepositorySpec = {
    name: basename(repositoryPath),
    path: repositoryPath,
    remote: await gitOutput(git, ["git", "remote", "get-url", "origin"], repositoryPath),
    worktreeRoot: join(dirname(repositoryPath), "worktrees", basename(repositoryPath)),
    baseBranch: claimHome.defaultBranch,
  };
  const workspace = new GitWorkspaceAdapter(
    repository,
    git,
    gitWorkspaceFileSystem(lockExecution),
    () => branch,
  );
  await workspace.preflight(ticket);
  const worktree = await workspace.plan(ticket);
  const marker =
    tracker.tracker.mirror === "structured" ? await tracker.tracker.claimMarker(ref) : null;
  if (marker) throw new Error(`${input.key} is already claimed through claim home ${marker.home}`);
  const homeLock = claimCoordination(
    repository,
    tracker.tracker,
    services,
    claimHome.home,
  ).claimLock;
  if (heldClaim(await homeLock.read(ref)))
    throw new Error(`${input.key} is already claimed in claim home ${claimHome.home.identity}`);
  const claimTarget = {
    claimHome: claimHome.home.identity,
    claimHomeUrl: claimHome.home.url,
    recordVersion: CLAIM_RECORD_VERSION,
    lockRef: await homeLock.ref(ref),
    configCommit: claimHome.configCommit,
  };
  const instructions = loadConfigurationInstructions(configuration, ticketKind(ticket));
  const defaultsMessage =
    "T3 uses the calling thread's or project's default harness, model and modes; modelSelection is omitted and no catalog selection is verified.";
  const prompt =
    (catalog ? "" : `${defaultsMessage}\n\n`) +
    buildLaunchPrompt(ticket, {
      tracker: site,
      ...(instructions.runtimeContract
        ? { runtimeContract: instructions.runtimeContract.resolvedPath }
        : {}),
      ...(instructions.roleTemplate ? { roleTemplate: instructions.roleTemplate.content } : {}),
      lane: {
        command: selfCommand(),
        ...(input.state ? { state: resolve(statePath) } : {}),
        reviewers: Object.fromEntries(
          Object.entries(models.reviewers).map(([lens, target]) => [lens, t3Target(target)]),
        ),
      },
    });
  const plan: PickupPlan = {
    version: 1,
    repository: repository.name,
    ticket: ref,
    worktree: worktree.path,
    branch: worktree.branch,
    title: `${input.key}: ${ticket.title ?? input.key}`,
    ...(models.implementer ? { modelSelection: models.implementer } : {}),
    reviewers: models.reviewers,
    review: reviewPolicy(Object.keys(models.reviewers)),
    prompt,
    hostVerification: catalog
      ? {
          source: "caller-supplied-t3-catalog",
          observedAt: catalog.observedAt,
          sessionId: catalog.catalog.parentSessionId,
        }
      : { source: "host-defaults", message: defaultsMessage },
    instructions: Object.values(instructions).map(({ content: _content, ...source }) => source),
    claimHome: {
      home: claimHome.home.identity,
      url: claimHome.home.url,
      source: claimHome.source,
      change: CHANGE_CLAIM_HOME,
      lockRef: claimTarget.lockRef,
      recordVersion: CLAIM_RECORD_VERSION,
      configCommit: claimHome.configCommit,
    },
    launch: {
      title: `${input.key}: ${ticket.title ?? input.key}`,
      message: prompt,
      ...(models.implementer ? { modelSelection: models.implementer } : {}),
      runtimeMode: models.runtimeMode,
      interactionMode: models.interactionMode,
      workspaceStrategy: {
        type: "existing_worktree",
        worktreePath: worktree.path,
        branch: worktree.branch,
      },
    },
  };
  verifyCatalog();
  let binding: T3LaneBinding | undefined;
  const branchExists = (name: string) => branchKnown(git, repositoryPath, name);
  const t3 = services.execution?.t3;
  const host = input.launch
    ? new T3HostPort({
        project: repositoryPath,
        ...(user.t3_cli ? { cli: user.t3_cli } : {}),
        ...(t3?.process ? { process: t3.process } : {}),
        ...(t3?.server ? { server: t3.server } : {}),
        ...(t3?.sleep ? { sleep: t3.sleep } : {}),
        lanes: (query) =>
          binding &&
          ("lane" in query ? query.lane === binding.lane : query.ticket === binding.ticket)
            ? [binding]
            : [],
        branchExists,
      })
    : undefined;
  if (host) {
    if (
      Object.keys(models.implementer?.options ?? {}).length ||
      settings.runtime_mode ||
      settings.interaction_mode
    )
      throw new HostRefusal(
        "host_unsupported",
        "t3 thread start binds only the harness and model; unset model options and modes or launch through T3",
      );
    await host.preflight();
    if (await branchExists(worktree.branch))
      throw new HostRefusal("branch_exists", `Branch ${worktree.branch} already exists`);
  }
  if (input.dryRun) return { ...plan, dryRun: true, state: "planned" } satisfies PickupResult;
  await workspace.refreshBase();
  const baseCommit = host
    ? await gitOutput(
        git,
        ["git", "rev-parse", "--verify", `refs/remotes/origin/${repository.baseBranch}^{commit}`],
        repositoryPath,
      )
    : undefined;
  return withExecutionStore(services, statePath, async (store) => {
    let journalRun: RunRef | undefined;
    const mirror = tracker.connection.tracker({
      claimHome: claimHome.home.identity,
      claimedStatus: settings.claimed_status,
      validateClaim: eligible,
      journalWrite(pending) {
        if (!journalRun) throw new Error("Tracker write requires a recorded run");
        return journalTrackerWrite(store, journalRun, pending);
      },
    });
    const { claimLock } = claimCoordination(repository, mirror, services, claimHome.home, () => {
      verifyCatalog();
    });
    const validateTicket = async (current: Ticket) => {
      await eligible(current);
      verifyCatalog();
    };
    const ledger: Ledger = {
      saveRun(run) {
        store.saveRun(run);
        journalRun = run.ref;
        if (!getExecutionConfiguration(store, run.ref))
          saveExecutionConfiguration(store, run.ref, { ...configuration, repository });
      },
      saveClaim: (claim) => store.saveClaim(claim),
      commitClaim: (claim, receipt) => store.commitClaim(claim, receipt),
      commitRun: (run, state, receipt) => store.commitRun(run, state, { receipt, plan }),
      recordStep: (run, state, receipt, error) =>
        store.recordStep(run, state, { receipt, plan }, error),
      saveRecoveryRequired: (run, receipt, error, evidence) => {
        const pendingTrackerWrite = mirror.pendingWrite?.(ref);
        store.saveRecoveryRequired(run, receipt, error, {
          ...z.record(z.string(), z.unknown()).parse(evidence),
          ...(pendingTrackerWrite ? { pendingTrackerWrite } : {}),
        });
      },
    };
    let launcher: HostLaunchWorkspace<T3LaunchPlan> | undefined;
    if (host && baseCommit) {
      const existing = store.laneForTicket(ref);
      const unattached = existing && isUnattached(existing) ? existing : undefined;
      if (existing && existing.state !== "done" && !unattached)
        throw new Error(`claim_collision: ${input.key} already has lane ${existing.id}`);
      const lane =
        unattached ??
        createLane(
          { id: laneRefSchema.parse(`interlock-lane:${randomUUID()}`), ticket: ref },
          clock.now().toISOString(),
        );
      if (!unattached) store.saveLane(lane);
      binding = { lane: lane.id, ticket: ref, key: input.key };
      launcher = new HostLaunchWorkspace({
        workspace,
        host,
        plan: {
          ...binding,
          project: repositoryPath,
          title: plan.title,
          message: prompt,
          baseCommit,
          branch: worktree.branch,
          ...(models.implementer
            ? {
                modelSelection: {
                  instanceId: models.implementer.instanceId,
                  model: models.implementer.model,
                },
              }
            : {}),
        },
        operation: [lane.id, "launch"],
        record(state, evidence) {
          if (!journalRun) throw new Error("Host launch requires a recorded run");
          store.recordStep(journalRun, state, { evidence, plan });
        },
      });
    }
    const receipt = await new PickupCoordinator({
      tracker: mirror,
      claimLock,
      validateTicket,
      workspace: launcher ?? workspace,
      ledger,
      clock,
      claimTarget,
      ids: {
        run: () => `interlock-run:${randomUUID()}`,
        claim: () => `interlock-claim:${randomUUID()}`,
      },
    }).prepare({
      ticket: ref,
      owner: tracker.owner,
      host: adapterRefSchema.parse("t3"),
      harness: adapterRefSchema.parse(models.implementer?.harness ?? "host-default"),
      ...(models.implementer ? { model: models.implementer.model } : {}),
    });
    const claimHomeSaved = saveClaimHomeIfAbsent(store, claimHome.home.url);
    const launched = launcher?.launched;
    return {
      ...plan,
      ...(launched?.workspace ? { worktree: launched.workspace.path } : {}),
      dryRun: false,
      state: "claimed",
      run: receipt.run,
      claim: receipt.claim,
      claimHomeSaved,
      ...(launched?.workspace
        ? {
            session: {
              id: launched.session.session,
              lane: launched.session.lane,
              ...(launched.link ? { link: launched.link } : {}),
              environment: launched.session.environment,
              harness: launched.session.harness,
              worktree: launched.workspace.path,
              branch: launched.workspace.branch,
            },
          }
        : {}),
    } satisfies PickupResult;
  });
}
