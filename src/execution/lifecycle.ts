import { z } from "zod";
import type {
  Clock,
  RecoveryVerification,
  RenewLeaseRequest,
  RunLifecycleAdapter,
  TrackerAdapter,
} from "../domain/contracts.ts";
import { claimRefSchema, ticketRefSchema } from "../domain/identifiers.ts";
import type { ActorRef, Claim, ClaimRef, Run, RunObservation, RunRef } from "../domain/model.ts";
import { capabilities, claimStatusAt, requireCapabilities, stopRun } from "../domain/model.ts";
import type { StateStore } from "../persistence/state.ts";

export interface SupervisorOptions {
  store: StateStore;
  tracker: TrackerAdapter;
  lifecycle(run: Run): RunLifecycleAdapter;
  clock: Clock;
  leaseDurationMs?: number;
  supervisorId?: string;
  supervisorLockMs?: number;
  lockClock?: () => Date;
  heartbeatScheduler?: SupervisorHeartbeatScheduler;
  /** Test/crash injection after remote verification and before the local transaction. */
  afterRenewVerified?: (run: Run) => void;
}

export interface SupervisorHeartbeatScheduler {
  start(callback: () => void, intervalMs: number): () => void;
}

const systemHeartbeatScheduler: SupervisorHeartbeatScheduler = {
  start(callback, intervalMs) {
    const heartbeat = setInterval(callback, intervalMs);
    return () => clearInterval(heartbeat);
  },
};

export class Supervisor {
  readonly #instanceId: string;

  constructor(private readonly options: SupervisorOptions) {
    this.#instanceId = options.supervisorId ?? `process:${process.pid}:${crypto.randomUUID()}`;
  }

  async tick(): Promise<Array<{ run: RunRef; outcome: string }>> {
    const owner = this.#instanceId;
    const lockClock = this.options.lockClock ?? (() => new Date());
    const lockMs = this.options.supervisorLockMs ?? 60_000;
    const startedAt = lockClock();
    if (
      !this.options.store.acquireSupervisor(
        owner,
        startedAt.toISOString(),
        new Date(startedAt.getTime() + lockMs).toISOString(),
      )
    ) {
      throw new Error("Another per-user supervisor holds the active lease");
    }

    const renewLock = () => {
      const now = lockClock();
      if (
        !this.options.store.refreshSupervisor(
          owner,
          now.toISOString(),
          new Date(now.getTime() + lockMs).toISOString(),
        )
      ) {
        throw new Error("Supervisor lease ownership was lost");
      }
    };
    const stopHeartbeat = (this.options.heartbeatScheduler ?? systemHeartbeatScheduler).start(
      () => {
        try {
          renewLock();
        } catch {
          // The foreground path checks the fence before every remote renewal.
        }
      },
      Math.max(1, Math.floor(lockMs / 3)),
    );
    const results: Array<{ run: RunRef; outcome: string }> = [];
    try {
      await this.#reconcilePendingRenewals(results, renewLock);
      for (const run of this.options.store.activeRuns()) {
        if (results.some((result) => result.run === run.ref)) continue;
        try {
          results.push(await this.#process(run, renewLock));
        } catch (error) {
          this.#attention(run, { phase: "supervision" }, error);
          results.push({ run: run.ref, outcome: "attention_required" });
        }
      }
      return results;
    } finally {
      stopHeartbeat();
      this.options.store.releaseSupervisor(owner);
    }
  }

  async #process(run: Run, renewLock: () => void): Promise<{ run: RunRef; outcome: string }> {
    const claim = this.options.store.claimForRun(run.ref);
    const observedClaimStatus = claimStatusAt(claim, this.options.clock.now());
    if (observedClaimStatus !== "active") {
      this.#attention(run, {
        phase: "claim_check",
        claim: claim.ref,
        status: observedClaimStatus,
        persistedStatus: claim.status,
      });
      return { run: run.ref, outcome: "attention_required" };
    }

    const lifecycle = this.options.lifecycle(run);
    requireCapabilities(lifecycle.capabilities, capabilities("session_status"));
    const observation = await lifecycle.observe(run);
    run.observation = observation;
    run.updatedAt = this.options.clock.now().toISOString();
    if (observation.state !== "running") {
      this.#attention(run, observation);
      return { run: run.ref, outcome: "attention_required" };
    }

    const renewalNow = this.options.clock.now();
    if (claimStatusAt(claim, renewalNow) !== "active") {
      this.#attention(run, { phase: "pre_renewal_claim_check", claim: claim.ref, status: "stale" });
      return { run: run.ref, outcome: "attention_required" };
    }
    const leaseExpiresAt = new Date(
      renewalNow.getTime() + (this.options.leaseDurationMs ?? 900_000),
    ).toISOString();
    const request: RenewLeaseRequest = {
      claim: claim.ref,
      ticket: claim.ticket,
      leaseExpiresAt,
      expectedVersion: claim.currentVersion ?? claim.previousState.version,
    };
    renewLock();
    this.options.store.beginRenewal(run.ref, claim.ref, request, renewalNow.toISOString());
    try {
      await this.options.tracker.renewLease(request);
    } catch (renewError) {
      try {
        await this.options.tracker.verifyLease(request);
      } catch (verifyError) {
        this.options.store.discardRenewal(run.ref);
        throw new AggregateError(
          [renewError, verifyError],
          "Lease renewal failed and was not applied",
        );
      }
    }
    await this.options.tracker.verifyLease(request);
    const verified = await this.options.tracker.snapshotClaimState(claim.ticket);
    this.options.afterRenewVerified?.(run);
    claim.leaseExpiresAt = leaseExpiresAt;
    claim.currentVersion = verified.version;
    this.options.store.commitRenewal(run, claim, { leaseExpiresAt, reconciled: false });
    return { run: run.ref, outcome: "renewed" };
  }

  async #reconcilePendingRenewals(
    results: Array<{ run: RunRef; outcome: string }>,
    renewLock: () => void,
  ): Promise<void> {
    for (const pending of this.options.store.pendingRenewals()) {
      const run = this.options.store.run(pending.run);
      try {
        const claim = this.options.store.claim(pending.claim);
        const request = z
          .object({
            claim: claimRefSchema,
            ticket: ticketRefSchema,
            leaseExpiresAt: z.string(),
            expectedVersion: z.string(),
          })
          .parse(pending.request);
        const now = this.options.clock.now();
        const staleClaim = claimStatusAt(claim, now) !== "active";
        if (staleClaim || now.getTime() >= Date.parse(request.leaseExpiresAt)) {
          run.status = "attention_required";
          run.updatedAt = now.toISOString();
          this.options.store.retireRenewal(
            run,
            request,
            new Error(staleClaim ? "Claim is stale" : "Pending renewal lease is already stale"),
          );
          results.push({ run: run.ref, outcome: "attention_required" });
          continue;
        }
        renewLock();
        await this.options.tracker.verifyLease(request);
        const verified = await this.options.tracker.snapshotClaimState(claim.ticket);
        claim.leaseExpiresAt = request.leaseExpiresAt;
        claim.currentVersion = verified.version;
        run.status = "active";
        run.updatedAt = this.options.clock.now().toISOString();
        this.options.store.commitRenewal(run, claim, {
          leaseExpiresAt: request.leaseExpiresAt,
          reconciled: true,
        });
        results.push({ run: run.ref, outcome: "renewal_reconciled" });
      } catch (error) {
        this.#attention(run, { phase: "renewal_reconciliation" }, error);
        results.push({ run: run.ref, outcome: "attention_required" });
      }
    }
  }

  #attention(run: Run, receipt: unknown, error?: unknown): void {
    run.status = "attention_required";
    run.updatedAt = this.options.clock.now().toISOString();
    this.options.store.markAttention(run, receipt, error);
  }
}

export class LifecycleCoordinator {
  constructor(
    private readonly store: StateStore,
    private readonly tracker: TrackerAdapter | undefined,
    private readonly lifecycle: (run: Run) => RunLifecycleAdapter,
    private readonly clock: Clock,
  ) {}

  async stop(ref: RunRef): Promise<Run> {
    const run = this.store.run(ref);
    if (run.status === "stopped") return run;
    // Adapter selection and capability checks are preflight: they never mutate the run.
    const lifecycle = this.lifecycle(run);
    requireCapabilities(
      lifecycle.capabilities,
      capabilities("session_interrupt", "session_status"),
    );
    try {
      await lifecycle.stop(run);
      const observation = await lifecycle.observe(run);
      if (observation.state !== "stopped" && observation.state !== "missing") {
        throw new Error(`Stop could not be verified; observed ${observation.state}`);
      }
      const stopped = stopRun({ ...run, observation }, this.clock.now());
      this.store.commitStopped(stopped, { operation: "stop", observation });
      return stopped;
    } catch (error) {
      run.status = "recovery_required";
      run.updatedAt = this.clock.now().toISOString();
      this.store.saveRecoveryRequired(run, { operation: "stop" }, error, {
        verification: "stop_unverified",
      });
      throw error;
    }
  }

  async release(ref: ClaimRef, authorizedBy: ActorRef): Promise<void> {
    if (!this.tracker) throw new Error("Claim release requires a configured tracker adapter");
    const claim = this.store.claim(ref);
    if (claim.status !== "active" && claim.status !== "stale") {
      throw new Error(`Claim cannot be released from ${claim.status}`);
    }
    const request = {
      claim: claim.ref,
      ticket: claim.ticket,
      claimedOwner: claim.humanOwner,
      originalSnapshot: claim.previousState,
      expectedVersion: claim.currentVersion ?? claim.previousState.version,
      authorizedBy,
    };
    try {
      await this.tracker.releaseClaim(request);
      await this.tracker.verifyReleased(request);
      claim.status = "released";
      this.store.commitRelease(claim, { claim: claim.ref });
    } catch (error) {
      const run = this.store.run(claim.run);
      run.status = "recovery_required";
      run.updatedAt = this.clock.now().toISOString();
      this.store.saveRecoveryRequired(run, { operation: "release", claim: claim.ref }, error, {
        verification: "release_unverified",
      });
      throw error;
    }
  }

  async recover(
    ref: RunRef,
    evidence: unknown,
    verify: (run: Run, evidence: unknown) => Promise<RecoveryVerification>,
  ): Promise<Run> {
    const run = this.store.run(ref);
    if (run.status !== "recovery_required") throw new Error(`Run is not awaiting recovery: ${ref}`);
    let verification: RecoveryVerification;
    try {
      verification = await verify(run, evidence);
    } catch (error) {
      this.store.commitRecovery(run, "verification_failed", { evidence, error: message(error) });
      return run;
    }
    if (!verification.verified) {
      this.store.commitRecovery(run, "verification_failed", verification.evidence);
      return run;
    }
    run.status = verification.resolvedStatus ?? "stopped";
    run.updatedAt = this.clock.now().toISOString();
    this.store.commitRecovery(run, "recovered", verification.evidence);
    return run;
  }

  reconcileAttention(ref: RunRef, observation: RunObservation, claim: Claim): Run {
    const run = this.store.run(ref);
    if (run.status !== "attention_required")
      throw new Error(`Run does not require attention: ${ref}`);
    if (observation.state !== "running" || claim.run !== ref || claim.status !== "active") {
      throw new Error(
        "Reconciliation requires a verified running session and active matching claim",
      );
    }
    run.status = "active";
    run.observation = observation;
    run.updatedAt = this.clock.now().toISOString();
    this.store.reconcileAttention(run, { observation, claim: claim.ref });
    return run;
  }
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
