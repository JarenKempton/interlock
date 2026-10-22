import type { RecoverableClaimLock } from "../domain/claim-lock.ts";
import type {
  Clock,
  HarnessAdapter,
  IdFactory,
  LaunchReceipt,
  Ledger,
  PickupRequest,
  WorkspaceAdapter,
} from "../domain/contracts.ts";
import { ClaimCollisionError, HarnessLaunchError } from "../domain/contracts.ts";
import {
  type CapabilitySet,
  type Claim,
  capabilities,
  type PreparedWorkspace,
  type Run,
  type RunRef,
  requireCapabilities,
  type Ticket,
  type TrackerSnapshot,
} from "../domain/model.ts";
import type { Tracker } from "../domain/tracker.ts";
import { ClaimCoordinator } from "./claims.ts";

export type PickupState =
  | "planning"
  | "claiming"
  | "claimed"
  | "workspace_prepared"
  | "launched"
  | "committed"
  | "compensating"
  | "compensated"
  | "collision"
  | "recovery_required";

export interface PickupReceipt {
  ok: boolean;
  state: PickupState;
  run: RunRef;
  claim: ReturnType<IdFactory["claim"]>;
  ticket: PickupRequest["ticket"];
  workspace?: PreparedWorkspace;
  launch?: LaunchReceipt;
  recoveryCommand?: string;
}

export class PickupResultError extends Error {
  constructor(
    readonly receipt: PickupReceipt,
    readonly cause: unknown,
  ) {
    super(`Pickup ended in ${receipt.state}: ${message(cause)}`, { cause });
    this.name = "PickupResultError";
  }
}

export interface PickupCoordinatorOptions {
  tracker: Tracker;
  claimLock: RecoverableClaimLock;
  validateTicket?: (ticket: Ticket) => void;
  beforeClaim?: () => void;
  workspace: WorkspaceAdapter;
  harness?: HarnessAdapter;
  ledger: Ledger;
  ids: IdFactory;
  clock: Clock;
  leaseDurationMs?: number;
}

export class PickupCoordinator {
  readonly #options: PickupCoordinatorOptions;
  readonly #claims: ClaimCoordinator;

  constructor(options: PickupCoordinatorOptions) {
    this.#options = options;
    this.#claims = new ClaimCoordinator(options.claimLock, options.tracker);
  }

  async execute(request: PickupRequest): Promise<PickupReceipt> {
    if (!this.#options.harness) throw new Error("No launch harness is composed");
    return this.#execute(request, this.#options.harness);
  }

  async prepare(request: PickupRequest): Promise<PickupReceipt> {
    return this.#execute(request);
  }

  async #execute(request: PickupRequest, harness?: HarnessAdapter): Promise<PickupReceipt> {
    if (!request.ticket || !request.owner || !request.harness) {
      throw new Error("Ticket, owner, and harness are required");
    }
    const runRef = this.#options.ids.run();
    const claimRef = this.#options.ids.claim();
    const now = this.#options.clock.now();
    const receipt: PickupReceipt = {
      ok: false,
      state: "planning",
      run: runRef,
      claim: claimRef,
      ticket: request.ticket,
    };
    const run: Run = {
      ref: runRef,
      ticket: request.ticket,
      harness: request.harness,
      workspace: { path: "" },
      capabilities: capabilities(),
      status: "planning",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const ticket = (await this.#options.tracker.read(request.ticket)).ticket;
    this.#options.validateTicket?.(ticket);
    if (ticket.state !== "open" || ticket.assignee !== undefined) {
      throw new Error("Ticket is not claimable");
    }
    requireCapabilities(
      await this.#options.claimLock.describe(),
      capabilities("conditional_update"),
    );
    await this.#options.workspace.preflight(ticket);
    const plan = await this.#options.workspace.plan(ticket);
    const harnessCapabilities = harness ? await harness.describe() : capabilities();
    if (harness) validateExecutionRoute(request, harnessCapabilities);
    await harness?.preflight({
      run: runRef,
      ticket,
      workspace: { path: plan.path, branch: plan.branch },
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.context ? { context: request.context } : {}),
    });

    const snapshot = await this.#claims.snapshotClaimState(request.ticket);
    run.workspace = { path: plan.path, branch: plan.branch };
    await this.#options.ledger.saveRun(run);
    await this.#options.ledger.recordStep(runRef, "planning", receipt);
    const claimRequest = {
      claim: claimRef,
      run: runRef,
      ticket: request.ticket,
      owner: request.owner,
      leaseExpiresAt: new Date(
        now.getTime() + (this.#options.leaseDurationMs ?? 900_000),
      ).toISOString(),
      expectedVersion: snapshot.version,
    };
    receipt.state = "claiming";
    await this.#options.ledger.recordStep(runRef, "claiming", {
      ...receipt,
      snapshot,
      owner: request.owner,
    });
    try {
      try {
        this.#options.beforeClaim?.();
        await this.#claims.claim(claimRequest);
      } catch (error) {
        if (error instanceof ClaimCollisionError) {
          receipt.state = "collision";
          run.status = "collision";
          await this.#options.ledger.commitRun(run, "collision", receipt);
          throw new PickupResultError(receipt, error);
        }
        return this.#compensate(run, receipt, snapshot, request.owner, error);
      }
      await this.#claims.verifyClaim(claimRequest);
      const verifiedSnapshot = await this.#claims.snapshotClaimState(request.ticket);
      const claim: Claim = {
        ref: claimRef,
        ticket: request.ticket,
        humanOwner: request.owner,
        run: runRef,
        previousState: snapshot,
        claimedAt: now.toISOString(),
        leaseExpiresAt: claimRequest.leaseExpiresAt,
        status: "active",
        currentVersion: verifiedSnapshot.version,
      };
      receipt.state = "claimed";
      await this.#options.ledger.commitClaim(claim, receipt);

      const prepared = await this.#options.workspace.prepare(plan);
      receipt.state = "workspace_prepared";
      receipt.workspace = prepared;
      await this.#options.ledger.recordStep(runRef, "workspace_prepared", receipt);

      run.workspace = prepared;
      run.status = "claimed";
      run.updatedAt = this.#options.clock.now().toISOString();
      if (request.model) run.model = request.model;
      if (request.effort) run.effort = request.effort;
      if (request.context) run.context = request.context;
      if (!harness) {
        receipt.ok = true;
        await this.#options.ledger.commitRun(run, "prepared", receipt);
        return receipt;
      }

      const launchRequest = {
        run: runRef,
        ticket,
        workspace: prepared,
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        ...(request.context ? { context: request.context } : {}),
      };
      const launch = await harness.launch(launchRequest);
      receipt.state = "launched";
      receipt.launch = launch;
      await this.#options.ledger.recordStep(runRef, "launched", receipt);

      run.workspace = prepared;
      run.execution = launch;
      run.status = "active";
      run.updatedAt = this.#options.clock.now().toISOString();
      if (request.model) run.model = request.model;
      if (request.effort) run.effort = request.effort;
      if (request.context) run.context = request.context;
      run.capabilities = harnessCapabilities;
      receipt.ok = true;
      receipt.state = "committed";
      await this.#options.ledger.commitRun(run, "committed", receipt);
      return receipt;
    } catch (error) {
      if (error instanceof PickupResultError) throw error;
      if (error instanceof HarnessLaunchError && error.receipt) {
        receipt.launch = error.receipt;
      }
      return this.#compensate(run, receipt, snapshot, request.owner, error);
    }
  }

  async #compensate(
    run: Run,
    receipt: PickupReceipt,
    snapshot: TrackerSnapshot,
    claimedOwner: PickupRequest["owner"],
    cause: unknown,
  ): Promise<never> {
    receipt.ok = false;
    receipt.state = "compensating";
    const recoveryErrors: unknown[] = [];
    let sessionEvidence = receipt.launch ? "verification_required" : "not_started";
    let trackerEvidence = "verification_required";
    let ledgerEvidence = "recorded";
    try {
      await this.#options.ledger.recordStep(receipt.run, "compensating", receipt, cause);
    } catch (error) {
      recoveryErrors.push(error);
      ledgerEvidence = "compensating_step_persistence_failed";
    }
    if (receipt.launch?.sessionId !== undefined || receipt.launch?.pid !== undefined) {
      try {
        if (!this.#options.harness) throw new Error("Launch harness is unavailable for recovery");
        await this.#options.harness.stop(receipt.launch);
        sessionEvidence = "stopped_verified";
      } catch (error) {
        recoveryErrors.push(error);
      }
    }
    const restoreRequest = {
      ticket: receipt.ticket,
      claim: receipt.claim,
      claimedOwner,
      originalSnapshot: snapshot,
    };
    try {
      await this.#claims.restoreClaimState(restoreRequest);
      await this.#claims.verifyRestored(restoreRequest);
      trackerEvidence = "restored_verified";
    } catch (error) {
      recoveryErrors.push(error);
    }
    if (recoveryErrors.length === 0) {
      receipt.state = "compensated";
      try {
        await this.#options.ledger.recordStep(receipt.run, "compensated", receipt, cause);
        await this.#options.ledger.saveClaim({
          ref: receipt.claim,
          ticket: receipt.ticket,
          humanOwner: claimedOwner,
          run: receipt.run,
          previousState: snapshot,
          claimedAt: run.createdAt,
          leaseExpiresAt: run.createdAt,
          status: "released",
        });
        run.status = "compensated";
        await this.#options.ledger.saveRun(run);
      } catch (error) {
        recoveryErrors.push(error);
        ledgerEvidence = "compensated_step_persistence_failed";
      }
      if (recoveryErrors.length === 0) throw new PickupResultError(receipt, cause);
    }
    receipt.state = "recovery_required";
    receipt.recoveryCommand = `interlock runs export ${receipt.run}`;
    const combined = new AggregateError(
      [cause, ...recoveryErrors],
      "Pickup compensation could not be fully verified",
    );
    run.status = "recovery_required";
    run.updatedAt = this.#options.clock.now().toISOString();
    try {
      await this.#options.ledger.saveRecoveryRequired(run, receipt, combined, {
        command: receipt.recoveryCommand,
        tracker: trackerEvidence,
        session: sessionEvidence,
        ledger: ledgerEvidence,
      });
    } catch (error) {
      throw new PickupResultError(
        receipt,
        new AggregateError(
          [combined, error],
          "Pickup requires recovery and its recovery ledger could not be persisted",
        ),
      );
    }
    throw new PickupResultError(receipt, combined);
  }
}

function validateExecutionRoute(route: PickupRequest, available: CapabilitySet): void {
  const required = { ...route.requiredCapabilities };
  if (route.model) required.model_selection = true;
  if (route.effort) required.reasoning_selection = true;
  if (route.context) required.context_selection = true;
  requireCapabilities(available, required);
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
