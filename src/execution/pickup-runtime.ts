import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { GitClaimLock, heldClaim } from "../adapters/claims/git-lock.ts";
import {
  JiraTrackerAdapter,
  type JiraTransport,
  jiraBasicAuthTransport,
} from "../adapters/trackers/jira.ts";
import {
  BunGitCommandExecutor,
  type GitCommandExecutor,
  GitWorkspaceAdapter,
} from "../adapters/workspaces/git.ts";
import {
  configurationReference,
  loadConfigurationInstructions,
  projectConfigPath,
} from "../configuration/files.ts";
import { readUserSettings } from "../configuration/local-settings.ts";
import { resolveSharedConfiguration, sharedConfiguration } from "../configuration/project-files.ts";
import type { ExecutionConfiguration } from "../configuration/schema.ts";
import type { ClaimHome } from "../domain/claim-home.ts";
import { CLAIM_RECORD_VERSION } from "../domain/claim-lock.ts";
import type { Clock, Ledger } from "../domain/contracts.ts";
import { actorRefSchema, adapterRefSchema, ticketRefSchema } from "../domain/identifiers.ts";
import type { RepositorySpec, RunRef, Ticket } from "../domain/model.ts";
import { ticketKeyMatches } from "../domain/submission.ts";
import { lockExecution } from "../persistence/execution-lock.ts";
import { databasePath } from "../persistence/paths.ts";
import { StateStore } from "../persistence/state.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { requireCredentials, trackerSignIns } from "../sign-in/credentials.ts";
import { CHANGE_CLAIM_HOME, resolveClaimHome } from "./claim-home.ts";
import { ClaimCoordinator } from "./claims.ts";
import { journalJiraWrite } from "./jira-write-journal.ts";
import { buildLaunchPrompt } from "./launch-prompt.ts";
import { PickupCoordinator } from "./pickup.ts";
import { planT3Models, validateT3Catalog } from "./t3-plan.ts";

export interface ExecutionPlatform {
  jira?: JiraTransport;
  git?: GitCommandExecutor;
  clock?: Clock;
  openStore?: (path: string) => StateStore;
}

export interface PickupInput {
  key: string;
  config?: string | undefined;
  repo?: string | undefined;
  branch?: string | undefined;
  state?: string | undefined;
  t3Catalog: string;
  dryRun?: boolean | undefined;
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

export function executionTarget(configuration: ExecutionConfiguration, repositoryName: string) {
  if (configuration.version === 2) {
    const { repository, settings } = configuration;
    if (!repository || !settings.jira_site)
      throw new Error("Recorded execution configuration has no repository or Jira site");
    return { repository, jiraSite: settings.jira_site, claimedStatus: settings.claimed_status };
  }
  const repository = configuration.project.repositories[repositoryName];
  if (!repository) throw new Error("Configured repository is missing");
  return {
    repository: {
      name: repositoryName,
      path: configurationReference(configuration.source.path, repository.path),
      worktreeRoot: configurationReference(configuration.source.path, repository.worktree_root),
      baseBranch: repository.base_branch,
      remote: `https://github.com/${repository.github}.git`,
    },
    jiraSite: configuration.project.tracker.jira.site,
    claimedStatus: "In Progress",
  };
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
  jiraSite: string,
  workspace: string,
  services: RuntimeServices,
  purpose: "pickup" | "release" = "pickup",
) {
  const site = new URL(jiraSite);
  if (
    !services.execution?.jira &&
    process.env.JIRA_SITE &&
    new URL(process.env.JIRA_SITE).origin !== site.origin
  )
    throw new Error("JIRA_SITE does not match the configured Jira site");
  const { adapter } = trackerSignIns(services).jira;
  const transport =
    services.execution?.jira ??
    jiraBasicAuthTransport(
      { site: site.origin, ...(await requireCredentials(services, "jira", adapter, site.origin)) },
      services.signIn?.http,
    );
  const read = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    const result = await transport.request("GET", `/rest/api/3/${path}`);
    const parsed = schema.safeParse(result.body);
    if (result.status !== 200 || !parsed.success) throw new Error(`Jira ${path} discovery failed`);
    return parsed.data;
  };
  const discovery = async () => {
    const fields = await read(
      "field",
      z.array(
        z.object({
          id: z.string(),
          schema: z.object({ custom: z.string().optional() }).optional(),
        }),
      ),
    );
    const ranks = fields.filter(
      (f) => f.schema?.custom === "com.pyxis.greenhopper.jira:gh-lexo-rank",
    );
    if (ranks.length !== 1 || !ranks[0]) throw new Error("Jira Rank field is missing or ambiguous");
    return { rankField: ranks[0].id };
  };
  const metadata = purpose === "pickup" ? await discovery() : {};
  const myself = await read("myself", z.object({ accountId: actorRefSchema }));
  const instance = site.hostname.replace(/\.atlassian\.net$/, "");
  const options = {
    instance,
    workspace,
    transport,
    ...metadata,
  };
  return { tracker: new JiraTrackerAdapter(options), owner: myself.accountId, instance, options };
}

export function claimCoordination(
  repository: RepositorySpec,
  tracker: JiraTrackerAdapter,
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
  if (!/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(input.key))
    throw new Error("Pickup requires a canonical Jira key");
  const cwd = services.configuration?.cwd ?? process.cwd();
  const statePath = executionStatePath(services, input.state);
  const git = services.execution?.git ?? new BunGitCommandExecutor();
  const repositoryPath = await mainCheckout(git, resolve(cwd, input.repo ?? "."));
  const configPath = projectConfigPath(
    input.config ? cwd : repositoryPath,
    input.config ?? "interlock.toml",
  );
  const user = readUserSettings(statePath);
  const configuration = resolveSharedConfiguration(
    configPath,
    sharedConfiguration(configPath, input.config !== undefined),
    user,
  );
  const { settings } = configuration;
  if (!settings.jira_site)
    throw new Error(
      "Jira site is unknown; run interlock login jira or interlock config edit --set jira_site URL",
    );
  const branch = input.branch ?? settings.branch.replaceAll("{key}", input.key);
  if (!ticketKeyMatches(branch, input.key))
    throw new Error(`Branch ${branch} must contain ${input.key}`);
  if (
    (await git.run(["git", "check-ref-format", "--branch", branch], repositoryPath)).exitCode !== 0
  )
    throw new Error(`Branch ${branch} is not a valid Git branch name`);
  const rawCatalog: unknown = JSON.parse(
    input.t3Catalog === "-"
      ? await Bun.stdin.text()
      : readFileSync(resolve(cwd, input.t3Catalog), "utf8"),
  );
  const clock = services.execution?.clock ?? { now: () => new Date() };
  const catalog = validateT3Catalog(rawCatalog, clock.now());
  const models = planT3Models(configuration, catalog);
  const jira = await executionTracker(
    settings.jira_site,
    input.key.slice(0, input.key.lastIndexOf("-")),
    services,
  );
  const ref = ticketRefSchema.parse(
    `jira:${jira.instance}:${input.key.slice(0, input.key.lastIndexOf("-"))}:ticket:${input.key}`,
  );
  const ticket = (await jira.tracker.read(ref)).ticket;
  const pickable = settings.pickable_statuses;
  const eligible = async (current: Ticket) => {
    if (
      current.state !== "open" ||
      current.assignee !== undefined ||
      !pickable.includes(current.status)
    )
      throw new Error(
        `Ticket is not available; pickup needs an open, unassigned ticket in ${pickable.join(", ")}`,
      );
    if (JSON.stringify({ ...current, order: 0 }) !== JSON.stringify({ ...ticket, order: 0 }))
      throw new Error("Ticket changed during planning; retry pickup");
    for (const dependency of current.dependencies ?? []) {
      if ((await jira.tracker.read(dependency.blocking)).ticket.state !== "closed")
        throw new Error("Ticket is not available; unfinished dependencies block pickup");
    }
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
  const workspace = new GitWorkspaceAdapter(repository, git, undefined, () => branch);
  await workspace.preflight(ticket);
  const worktree = await workspace.plan(ticket);
  const marker = await jira.tracker.claimMarker(ref);
  if (marker) throw new Error(`${input.key} is already claimed through claim home ${marker.home}`);
  const homeLock = claimCoordination(repository, jira.tracker, services, claimHome.home).claimLock;
  if (heldClaim(await homeLock.read(ref)))
    throw new Error(`${input.key} is already claimed in claim home ${claimHome.home.identity}`);
  const claimTarget = {
    claimHome: claimHome.home.identity,
    claimHomeUrl: claimHome.home.url,
    recordVersion: CLAIM_RECORD_VERSION,
    lockRef: await homeLock.ref(ref),
    configCommit: claimHome.configCommit,
  };
  const instructions = loadConfigurationInstructions(configuration, ticket.kind);
  const prompt = buildLaunchPrompt(ticket, {
    tracker: settings.jira_site,
    ...(instructions.runtimeContract
      ? { runtimeContract: instructions.runtimeContract.resolvedPath }
      : {}),
    ...(instructions.roleTemplate ? { roleTemplate: instructions.roleTemplate.content } : {}),
  });
  const plan = {
    version: 1,
    repository: repository.name,
    ticket: ref,
    worktree: worktree.path,
    branch: worktree.branch,
    title: `${input.key}: ${ticket.title ?? input.key}`,
    modelSelection: models.implementer,
    reviewers: models.reviewers,
    prompt,
    hostVerification: {
      source: "caller-supplied-t3-catalog",
      observedAt: catalog.observedAt,
      threadId: catalog.catalog.parentThreadId,
    },
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
      modelSelection: models.implementer,
      runtimeMode: models.runtimeMode,
      interactionMode: models.interactionMode,
      workspaceStrategy: {
        type: "existing_worktree",
        worktreePath: worktree.path,
        branch: worktree.branch,
      },
    },
  };
  validateT3Catalog(catalog, clock.now());
  if (input.dryRun) return { ...plan, dryRun: true, state: "planned" };
  return withExecutionStore(services, statePath, async (store) => {
    let journalRun: RunRef | undefined;
    const mirror = new JiraTrackerAdapter({
      ...jira.options,
      claimHome: claimHome.home.identity,
      claimedStatus: settings.claimed_status,
      validateClaim: eligible,
      journalWrite(pending) {
        if (!journalRun) throw new Error("Jira write requires a recorded run");
        return journalJiraWrite(store, journalRun, pending);
      },
    });
    const { claimLock } = claimCoordination(repository, mirror, services, claimHome.home, () => {
      validateT3Catalog(catalog, clock.now());
    });
    const validateTicket = async (current: Ticket) => {
      await eligible(current);
      validateT3Catalog(catalog, clock.now());
    };
    const ledger: Ledger = {
      saveRun(run) {
        store.saveRun(run);
        journalRun = run.ref;
        if (!store.getExecutionConfiguration(run.ref))
          store.saveExecutionConfiguration(run.ref, { ...configuration, repository });
      },
      saveClaim: (claim) => store.saveClaim(claim),
      commitClaim: (claim, receipt) => store.commitClaim(claim, receipt),
      commitRun: (run, state, receipt) => store.commitRun(run, state, { receipt, plan }),
      recordStep: (run, state, receipt, error) =>
        store.recordStep(run, state, { receipt, plan }, error),
      saveRecoveryRequired: (run, receipt, error, evidence) => {
        const pendingJiraWrite = mirror.pendingWrite(ref);
        store.saveRecoveryRequired(run, receipt, error, {
          ...z.record(z.string(), z.unknown()).parse(evidence),
          ...(pendingJiraWrite ? { pendingJiraWrite } : {}),
        });
      },
    };
    const receipt = await new PickupCoordinator({
      tracker: mirror,
      claimLock,
      validateTicket,
      workspace,
      ledger,
      clock,
      claimTarget,
      ids: {
        run: () => `interlock-run:${randomUUID()}`,
        claim: () => `interlock-claim:${randomUUID()}`,
      },
    }).prepare({
      ticket: ref,
      owner: jira.owner,
      harness: adapterRefSchema.parse("t3"),
      model: models.implementer.model,
    });
    const claimHomeSaved = store.saveClaimHomeIfAbsent(claimHome.home.url);
    return {
      ...plan,
      dryRun: false,
      state: "claimed",
      run: receipt.run,
      claim: receipt.claim,
      claimHomeSaved,
    };
  });
}
