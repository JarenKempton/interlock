import type { z } from "zod";
import {
  type HostCapability,
  type HostLaunchResult,
  type HostRecoveryResult,
  HostRefusal,
  type HostSession,
  type HostSessionView,
  type HostSteerResult,
} from "../../../domain/host/capability.ts";
import { adapterRefSchema } from "../../../domain/refs/identifiers.ts";
import type { LaneRef, TicketRef } from "../../../domain/model.ts";
import type { OperationIdentity } from "../../../domain/operation/identity.ts";
import {
  bunT3Process,
  descriptorSchema,
  hostT3Cli,
  launchedSchema,
  listSchema,
  parseJson,
  readT3ServerDescriptor,
  sentSchema,
  showSchema,
  type T3Process,
  type threadSchema,
  versionCore,
} from "./cli.ts";

export interface T3LaunchPlan {
  project: string;
  lane: LaneRef;
  ticket: TicketRef;
  key: string;
  title: string;
  message: string;
  baseCommit: string;
  branch: string;
  modelSelection?: { instanceId: string; model: string };
}

export interface T3LaneBinding {
  lane: LaneRef;
  ticket: TicketRef;
  key: string;
}

export interface T3HostPortOptions {
  project: string;
  cli?: string;
  process?: T3Process;
  server?: () => Promise<unknown>;
  lanes: (query: { lane: LaneRef } | { ticket: TicketRef }) => readonly T3LaneBinding[];
  branchExists: (branch: string) => Promise<boolean>;
  readbackAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const PROTOCOL = 2;
const FAILED = new Set(["failed", "cancelled", "rolled_back", "interrupted"]);
type Thread = z.infer<typeof threadSchema>;

export class T3HostPort implements HostCapability<T3LaunchPlan> {
  readonly #options: T3HostPortOptions;
  readonly #cli: string;
  readonly #process: T3Process;
  #environment: string | undefined;

  constructor(options: T3HostPortOptions) {
    this.#options = options;
    this.#cli = options.cli ?? hostT3Cli();
    this.#process = options.process ?? bunT3Process;
  }

  async preflight(): Promise<void> {
    const version = await this.#t3(["--version"]);
    const cliVersion = version.exitCode === 0 ? /^t3 (\S+)$/m.exec(version.stdout)?.[1] : undefined;
    if (!cliVersion)
      throw new HostRefusal(
        "host_unavailable",
        `The t3 CLI at ${this.#cli} is not runnable: ${detail(version)}`,
      );
    const descriptor = descriptorSchema.safeParse(await this.#descriptor());
    if (!descriptor.success)
      throw new HostRefusal("host_unavailable", "The T3 server did not describe its environment");
    const { serverVersion, orchestrationProtocolVersion, environmentId } = descriptor.data;
    if (
      !versionCore(cliVersion) ||
      versionCore(cliVersion) !== versionCore(serverVersion) ||
      orchestrationProtocolVersion !== PROTOCOL
    )
      throw new HostRefusal(
        "host_incompatible",
        `t3 CLI ${cliVersion} is not compatible with T3 server ${serverVersion} (protocol ${orchestrationProtocolVersion}); use a t3 CLI that matches the running server`,
      );
    const listed = await this.#t3(["thread", "list", "--project", this.#options.project, "--json"]);
    if (listed.exitCode !== 0 || !parseJson(listSchema, listed.stdout))
      throw new HostRefusal(
        "host_unavailable",
        `T3 cannot list threads for project ${this.#options.project}: ${detail(listed)}`,
      );
    this.#environment = environmentId;
  }

  async launch(request: {
    operation: OperationIdentity;
    plan: T3LaunchPlan;
  }): Promise<HostLaunchResult> {
    const { plan } = request;
    if (!/^[0-9a-f]{40}$/.test(plan.baseCommit))
      throw new HostRefusal(
        "host_unsupported",
        "A host launch needs the exact fetched base commit",
      );
    let exists: boolean;
    try {
      exists = await this.#options.branchExists(plan.branch);
    } catch (error) {
      throw new HostRefusal(
        "host_unavailable",
        `Cannot verify branch ${plan.branch}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (exists) throw new HostRefusal("branch_exists", `Branch ${plan.branch} already exists`);
    const environment = await this.#environmentId();
    const started = await this.#t3(
      [
        "thread",
        "start",
        plan.project,
        "-",
        "--title",
        plan.title,
        "--worktree",
        plan.baseCommit,
        "--branch",
        plan.branch,
        ...(plan.modelSelection
          ? ["--provider", plan.modelSelection.instanceId, "--model", plan.modelSelection.model]
          : []),
        "--json",
      ],
      plan.message,
    );
    const launched = started.exitCode === 0 ? parseJson(launchedSchema, started.stdout) : undefined;
    if (!launched)
      return {
        state: "ambiguous",
        reason:
          started.exitCode === 0
            ? "t3 thread start exited 0 without a readable thread"
            : `t3 thread start failed: ${detail(started)}`,
        acknowledged: started.exitCode === 0,
      };
    return this.#readback(environment, plan, launched.threadId, launched.projectId);
  }

  async find(query: { lane: LaneRef } | { ticket: TicketRef }): Promise<readonly HostSession[]> {
    const bindings = this.#options.lanes(query);
    if (bindings.length === 0) return [];
    const threads = await this.#list();
    if (!threads) throw new HostRefusal("host_unavailable", "T3 thread list is unreadable");
    const environment = await this.#environmentId();
    return bindings.flatMap((binding) =>
      threads
        .filter((thread) => thread.title.startsWith(`${binding.key}:`))
        .map((thread) => session(environment, binding, thread)),
    );
  }

  async read(target: HostSession): Promise<HostSessionView> {
    const shown = await this.#show(target.session);
    if (!shown)
      throw new HostRefusal("host_unavailable", `T3 thread ${target.session} is unreadable`);
    return view(session(target.environment, target, shown.thread), shown);
  }

  async steer(request: {
    operation: OperationIdentity;
    session: HostSession;
    message: string;
  }): Promise<HostSteerResult> {
    const sent = await this.#t3(
      ["thread", "send", request.session.session, "-", "--json"],
      request.message,
    );
    const parsed = sent.exitCode === 0 ? parseJson(sentSchema, sent.stdout) : undefined;
    return parsed?.threadId === request.session.session
      ? { state: "delivered" }
      : { state: "ambiguous", reason: `t3 thread send was not confirmed: ${detail(sent)}` };
  }

  async recover(request: {
    operation: OperationIdentity;
    plan: T3LaunchPlan;
  }): Promise<HostRecoveryResult> {
    const { plan } = request;
    const environment = await this.#environmentId();
    const threads = await this.#list(plan.project);
    if (!threads) return { state: "ambiguous", reason: "T3 thread list is unreadable" };
    const candidates = threads.filter((thread) => thread.title === plan.title);
    if (candidates.length === 0) {
      if (await this.#options.branchExists(plan.branch))
        return { state: "ambiguous", reason: `Branch ${plan.branch} exists without a T3 thread` };
      return {
        state: "not_launched",
        evidence: `No T3 thread titled ${plan.title} and no branch ${plan.branch}`,
      };
    }
    if (candidates.length > 1)
      return { state: "ambiguous", reason: `${candidates.length} T3 threads match ${plan.title}` };
    const [candidate] = candidates;
    if (!candidate) return { state: "ambiguous", reason: "T3 thread list changed" };
    const result = await this.#readback(environment, plan, candidate.threadId, candidate.projectId);
    return result.state === "launched"
      ? { ...result, state: "found" }
      : { state: "ambiguous", reason: result.reason };
  }

  async #readback(
    environment: string,
    plan: T3LaunchPlan,
    threadId: string,
    projectId: string,
  ): Promise<HostLaunchResult> {
    const attempts = this.#options.readbackAttempts ?? 60;
    const sleep = this.#options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const unresolved = { state: "ambiguous", acknowledged: true } as const;
    let last = `T3 thread ${threadId} is not readable`;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(1_000);
      const shown = await this.#show(threadId);
      if (!shown) continue;
      const { thread } = shown;
      if (thread.projectId !== projectId || thread.title !== plan.title)
        return { ...unresolved, reason: `T3 thread ${threadId} does not match the launch` };
      const selected = plan.modelSelection;
      if (
        selected &&
        (thread.providerInstanceId !== selected.instanceId || thread.model !== selected.model)
      )
        return {
          ...unresolved,
          reason: `T3 thread ${threadId} runs ${thread.providerInstanceId}/${thread.model}, not ${selected.instanceId}/${selected.model}`,
        };
      if (FAILED.has(thread.status))
        return { ...unresolved, reason: `T3 thread ${threadId} ended ${thread.status}` };
      if (thread.branch !== null && thread.branch !== plan.branch)
        return {
          ...unresolved,
          reason: `T3 thread ${threadId} is on ${thread.branch}, not ${plan.branch}`,
        };
      if (thread.branch === plan.branch && thread.worktreePath !== null) {
        const found = session(environment, plan, thread);
        return { state: "launched", session: found, view: view(found, shown) };
      }
      last = `T3 thread ${threadId} has no bound worktree (${thread.status})`;
    }
    return { ...unresolved, reason: last };
  }

  async #list(project = this.#options.project) {
    const listed = await this.#t3(["thread", "list", "--project", project, "--json"]);
    return listed.exitCode === 0 ? parseJson(listSchema, listed.stdout) : undefined;
  }

  async #show(threadId: string) {
    const shown = await this.#t3(["thread", "show", threadId, "--messages", "10", "--json"]);
    return shown.exitCode === 0 ? parseJson(showSchema, shown.stdout) : undefined;
  }

  async #environmentId(): Promise<string> {
    if (this.#environment) return this.#environment;
    const descriptor = descriptorSchema.safeParse(await this.#descriptor());
    if (!descriptor.success)
      throw new HostRefusal("host_unavailable", "The T3 server did not describe its environment");
    this.#environment = descriptor.data.environmentId;
    return this.#environment;
  }

  async #descriptor(): Promise<unknown> {
    try {
      return await (this.#options.server ?? readT3ServerDescriptor)();
    } catch (error) {
      throw new HostRefusal(
        "host_unavailable",
        `The T3 server is not reachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #t3(args: readonly string[], stdin?: string) {
    try {
      return await this.#process.run([this.#cli, "--log-level", "error", ...args], stdin);
    } catch (error) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function session(
  environment: string,
  binding: { lane: LaneRef; ticket: TicketRef },
  thread: Pick<Thread, "threadId" | "providerInstanceId">,
): HostSession {
  return {
    environment,
    host: adapterRefSchema.parse("t3"),
    harness: adapterRefSchema.parse(thread.providerInstanceId),
    session: thread.threadId,
    lane: binding.lane,
    ticket: binding.ticket,
  };
}

function view(
  target: HostSession,
  shown: { thread: Thread; messages: { role: string; text: string }[] },
): HostSessionView {
  const { thread } = shown;
  return {
    session: target,
    status: thread.status,
    ...(thread.link ? { link: thread.link } : {}),
    ...(thread.branch !== null && thread.worktreePath !== null
      ? { workspace: { path: thread.worktreePath, branch: thread.branch } }
      : {}),
    messages: shown.messages,
  };
}

function detail(result: { exitCode: number; stderr: string }): string {
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[\d:.]+\] WARN/.test(line) && !/^[{}'\]]|divergent/.test(line));
  return lines.at(-1) ?? `exit ${result.exitCode}`;
}
