import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { GitClaimLock } from "../adapters/claims/git-lock.ts";
import {
  JiraTrackerAdapter,
  type JiraTransport,
  jiraBasicAuthTransport,
} from "../adapters/trackers/jira.ts";
import { type GitCommandExecutor, GitWorkspaceAdapter } from "../adapters/workspaces/git.ts";
import { configurationReference, loadConfigurationInstructions } from "../configuration/files.ts";
import { configurationOperations } from "../configuration/project-files.ts";
import type { ResolvedConfiguration } from "../configuration/schema.ts";
import type { Clock, Ledger } from "../domain/contracts.ts";
import { actorRefSchema, adapterRefSchema, ticketRefSchema } from "../domain/identifiers.ts";
import type { RepositorySpec, RunRef, Ticket, TicketRef } from "../domain/model.ts";
import { parseRef } from "../domain/reference.ts";
import { evaluateFrontier } from "../frontier/evaluate.ts";
import { lockExecution } from "../persistence/execution-lock.ts";
import { databasePath } from "../persistence/paths.ts";
import { StateStore } from "../persistence/state.ts";
import type { RuntimeServices } from "../runtime-services.ts";
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

export function repositorySpec(configuration: ResolvedConfiguration, name: string): RepositorySpec {
  const repository = configuration.project.repositories[name];
  if (!repository) throw new Error("Configured repository is missing");
  return {
    name,
    path: configurationReference(configuration.source.path, repository.path),
    worktreeRoot: configurationReference(configuration.source.path, repository.worktree_root),
    baseBranch: repository.base_branch,
    remote: `https://github.com/${repository.github}.git`,
    ticketKeyWorkspaces: true,
  };
}

export async function executionTracker(
  configuration: ResolvedConfiguration,
  workspace: string,
  services: RuntimeServices,
  purpose: "pickup" | "release" = "pickup",
) {
  const site = new URL(configuration.project.tracker.jira.site);
  if (
    !services.execution?.jira &&
    process.env.JIRA_SITE &&
    new URL(process.env.JIRA_SITE).origin !== site.origin
  )
    throw new Error("JIRA_SITE does not match the project configuration");
  const transport =
    services.execution?.jira ?? jiraBasicAuthTransport({ ...process.env, JIRA_SITE: site.origin });
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
    const priorities = await read("priority", z.array(z.object({ name: z.string() })).min(1));
    return { rankField: ranks[0].id, priorityOrder: priorities.map((p) => p.name) };
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
  beforeClaimWrite?: () => void,
) {
  const claimLock = new GitClaimLock({
    repository: repository.path,
    remote: "origin",
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
  const configuration = (
    await configurationOperations({ cwd, statePath }).show({ path: input.config })
  ).configuration;
  const rawCatalog: unknown = JSON.parse(
    input.t3Catalog === "-"
      ? await Bun.stdin.text()
      : readFileSync(resolve(cwd, input.t3Catalog), "utf8"),
  );
  const clock = services.execution?.clock ?? { now: () => new Date() };
  const catalog = validateT3Catalog(rawCatalog, clock.now());
  const models = planT3Models(configuration, catalog);
  const jira = await executionTracker(
    configuration,
    input.key.slice(0, input.key.lastIndexOf("-")),
    services,
  );
  const ref = ticketRefSchema.parse(
    `jira:${jira.instance}:${input.key.slice(0, input.key.lastIndexOf("-"))}:ticket:${input.key}`,
  );
  const ticket = (await jira.tracker.read(ref)).ticket;
  const map = configuration.project.maps[parseRef(ticket.map).nativeId ?? ""];
  if (!map) throw new Error("Ticket map is not configured");
  if (map.claim_status !== "In Progress")
    throw new Error("Jira mirror supports only the In Progress claim status");
  const eligible = async (current: Ticket) => {
    if (
      current.map !== ticket.map ||
      current.state !== "open" ||
      current.assignee !== undefined ||
      !map.available_statuses.includes(current.status)
    )
      throw new Error("Ticket is not available in the configured map");
    if (JSON.stringify({ ...current, order: 0 }) !== JSON.stringify({ ...ticket, order: 0 }))
      throw new Error("Ticket changed during planning; retry pickup");
    const graph = new Map<TicketRef, Ticket>([[current.ref, current]]);
    for (const item of graph.values()) {
      for (const dependency of item.dependencies ?? []) {
        if (!graph.has(dependency.blocking))
          graph.set(dependency.blocking, (await jira.tracker.read(dependency.blocking)).ticket);
      }
    }
    if (
      evaluateFrontier(
        [...graph.values()],
        { ticket: current.ref },
        {
          availableStatuses: new Set(map.available_statuses),
        },
      ).length !== 1
    )
      throw new Error("Ticket is not available; unfinished dependencies block pickup");
  };
  await eligible(ticket);
  const repository = repositorySpec(configuration, map.repository);
  const workspace = new GitWorkspaceAdapter(repository, services.execution?.git);
  await workspace.preflight(ticket);
  const worktree = await workspace.plan(ticket);
  const instructions = loadConfigurationInstructions(configuration, ticket.kind);
  const prompt = buildLaunchPrompt(ticket, {
    tracker: configuration.project.tracker.jira.site,
    ...(instructions.runtimeContract
      ? { runtimeContract: instructions.runtimeContract.resolvedPath }
      : {}),
    ...(instructions.roleTemplate ? { roleTemplate: instructions.roleTemplate.content } : {}),
  });
  const plan = {
    version: 1,
    repository: map.repository,
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
      validateClaim: eligible,
      journalWrite(pending) {
        if (!journalRun) throw new Error("Jira write requires a recorded run");
        return journalJiraWrite(store, journalRun, pending);
      },
    });
    const { claimLock } = claimCoordination(repository, mirror, services, () => {
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
          store.saveExecutionConfiguration(run.ref, configuration);
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
    return { ...plan, dryRun: false, state: "claimed", run: receipt.run, claim: receipt.claim };
  });
}
