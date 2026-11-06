import type { WorkspaceAdapter, WorkspacePlan } from "../../domain/contracts.ts";
import {
  type HostCapability,
  HostLaunchUnresolvedError,
  HostRefusal,
  type HostSessionView,
} from "../../domain/host/capability.ts";
import type { PreparedWorkspace, Ticket } from "../../domain/model.ts";
import type { OperationIdentity } from "../../domain/operation/identity.ts";

export interface HostLaunchWorkspaceOptions<Plan> {
  workspace: Pick<WorkspaceAdapter, "preflight" | "plan">;
  host: HostCapability<Plan>;
  plan: Plan;
  operation: OperationIdentity;
  record: (state: "host_launching" | "host_launched", evidence: unknown) => void | Promise<void>;
}

export class HostLaunchWorkspace<Plan> implements WorkspaceAdapter {
  readonly #options: HostLaunchWorkspaceOptions<Plan>;
  #attempted = false;
  #launched: HostSessionView | undefined;

  constructor(options: HostLaunchWorkspaceOptions<Plan>) {
    this.#options = options;
  }

  get launched(): HostSessionView | undefined {
    return this.#launched;
  }

  async preflight(ticket: Ticket): Promise<void> {
    await this.#options.workspace.preflight(ticket);
    await this.#options.host.preflight();
  }

  async plan(ticket: Ticket): Promise<WorkspacePlan> {
    return { ...(await this.#options.workspace.plan(ticket)), path: "" };
  }

  async prepare(plan: WorkspacePlan): Promise<PreparedWorkspace> {
    if (this.#attempted)
      throw new HostLaunchUnresolvedError("A launch was already attempted for this claim");
    this.#attempted = true;
    const { host, operation } = this.#options;
    await this.#options.record("host_launching", { operation });
    let outcome: Awaited<ReturnType<HostCapability<Plan>["recover"]>>;
    let acknowledged = true;
    try {
      const launched = await host.launch({ operation, plan: this.#options.plan });
      if (launched.state === "ambiguous") acknowledged = launched.acknowledged;
      outcome =
        launched.state === "launched" ? { ...launched, state: "found" } : await this.#recover();
    } catch (error) {
      if (error instanceof HostRefusal && error.code === "branch_exists") throw error;
      outcome = await this.#recover();
    }
    if (outcome.state === "not_launched" && acknowledged)
      throw new HostLaunchUnresolvedError(
        `The host reported a launch that recovery cannot find: ${outcome.evidence}`,
      );
    if (outcome.state === "not_launched")
      throw new Error(`Host launch did not start a session: ${outcome.evidence}`);
    if (outcome.state === "ambiguous") throw new HostLaunchUnresolvedError(outcome.reason);
    const workspace = outcome.view.workspace;
    if (!workspace || workspace.branch !== plan.branch || !workspace.path)
      throw new HostLaunchUnresolvedError(
        `Session ${outcome.session.session} is not bound to ${plan.branch}`,
      );
    this.#launched = outcome.view;
    await this.#options.record("host_launched", { operation, session: outcome.session, workspace });
    return { path: workspace.path, branch: workspace.branch, ticket: plan.ticket };
  }

  async #recover(): Promise<Awaited<ReturnType<HostCapability<Plan>["recover"]>>> {
    try {
      return await this.#options.host.recover({
        operation: this.#options.operation,
        plan: this.#options.plan,
      });
    } catch (error) {
      return {
        state: "ambiguous",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
