import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RecoverableClaimLock } from "../src/domain/claim-lock.ts";
import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
  type HarnessAdapter,
  HarnessLaunchError,
  type LaunchReceipt,
  type Ledger,
  type ReleaseClaimRequest,
  type RestoreClaimRequest,
  type WorkspaceAdapter,
} from "../src/domain/contracts.ts";
import {
  actorRefSchema,
  adapterRefSchema,
  claimRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../src/domain/identifiers.ts";
import {
  type ClaimRef,
  capabilities,
  type Run,
  type RunRef,
  type Ticket,
  type TicketRef,
} from "../src/domain/model.ts";
import type {
  MirrorClaim,
  MirrorExpectation,
  MirrorRestore,
  Tracker,
} from "../src/domain/tracker.ts";
import { PickupCoordinator, PickupResultError } from "../src/execution/pickup.ts";
import { StateStore } from "../src/persistence/state.ts";
import { fakeLockFixture } from "./fixtures/portable-lock.ts";

class FailingCompensatedStateStore extends StateStore {
  readonly compensatedStepError = new Error("cannot persist compensated step");

  override recordStep(run: RunRef, state: string, receipt?: unknown, error?: unknown): void {
    if (state === "compensated") throw this.compensatedStepError;
    super.recordStep(run, state, receipt, error);
  }
}

class FakeLedger implements Ledger {
  readonly steps: string[] = [];
  recordStepError?: Error;
  recordStepErrorState?: string;
  saveRecoveryRequiredError?: Error;
  saveClaim(_claim: import("../src/domain/model.ts").Claim): void {}
  committedClaim?: import("../src/domain/model.ts").Claim;
  commitClaim(claim: import("../src/domain/model.ts").Claim): void {
    this.committedClaim = structuredClone(claim);
    this.steps.push("claimed");
  }
  recoveryRun?: Run;
  savedRun?: Run;
  saveRun(run: Run): void {
    this.savedRun = structuredClone(run);
  }
  commitRun(run: Run, state: string): void {
    this.savedRun = structuredClone(run);
    this.steps.push(state);
  }
  recordStep(_run: RunRef, state: string): void {
    if (state === this.recordStepErrorState && this.recordStepError) {
      throw this.recordStepError;
    }
    this.steps.push(state);
  }
  saveRecoveryRequired(run: Run): void {
    if (this.saveRecoveryRequiredError) throw this.saveRecoveryRequiredError;
    this.recoveryRun = structuredClone(run);
    this.steps.push("recovery_required");
  }
}

class FakeTracker implements Tracker {
  describedCapabilities = capabilities("native_maps", "native_dependencies");
  preflightError?: Error;
  restoreError?: Error;
  verifyClaimError?: Error;
  verifyRestoreError?: Error;
  claimRequest?: MirrorClaim;
  restoreRequest?: RestoreClaimRequest;
  claimCalls = 0;
  restoreCalls = 0;
  snapshotCalls = 0;

  async describe() {
    return this.describedCapabilities;
  }
  async list_work() {
    return [];
  }
  async read(ticket: TicketRef) {
    if (this.preflightError) throw this.preflightError;
    this.snapshotCalls += 1;
    return {
      ticket: await this.getTicket(ticket),
      snapshot:
        this.claimCalls === 0
          ? { version: "1", payload: { assignee: null, status: "To Do" } }
          : { version: "2", payload: { assignee: "human", status: "In Progress" } },
      artifacts: [],
    };
  }
  async getTicket(ticket: TicketRef): Promise<Ticket> {
    return {
      ref: ticket,
      map: mapRefSchema.parse("jira:x:W:map:M"),
      kind: "task",
      state: "open",
      status: "To Do",
      order: 0,
    };
  }
  async apply(request: MirrorClaim) {
    this.claimCalls += 1;
    this.claimRequest = request;
  }
  async verify(request: MirrorExpectation) {
    if (request.state === "applied" && this.verifyClaimError) throw this.verifyClaimError;
    if (request.state === "restored" && this.verifyRestoreError) throw this.verifyRestoreError;
  }
  async restore(request: MirrorRestore) {
    this.restoreCalls += 1;
    this.restoreRequest = request;
    if (this.restoreError) throw this.restoreError;
  }
}

class FakeLock implements RecoverableClaimLock {
  readonly core = fakeLockFixture().adapter;
  claimError?: Error;
  claimRequest?: ClaimRequest;
  describe = this.core.describe.bind(this.core);
  read = this.core.read.bind(this.core);
  renew = this.core.renew.bind(this.core);
  release = this.core.release.bind(this.core);
  async claim(request: ClaimRequest) {
    this.claimRequest = request;
    if (this.claimError instanceof ClaimCollisionError) throw this.claimError;
    await this.core.claim(request);
    if (this.claimError) throw this.claimError;
  }
  async releasable(request: ReleaseClaimRequest) {
    const state = await this.read(request.ticket);
    if (
      state.version !== request.expectedVersion ||
      state.record?.claim !== request.claim ||
      state.record.owner !== request.authorizedBy
    )
      throw new ClaimCollisionError();
    return state;
  }
  async restore(ticket: TicketRef, claim: ClaimRef) {
    const state = await this.read(ticket);
    if (state.record?.claim === claim && state.record.action !== "release")
      await this.release({
        ticket,
        claim,
        expectedVersion: state.version,
        authorizedBy: state.record.owner,
        originalSnapshot: { version: "opaque", payload: null },
      });
  }
}

class FakeWorkspace implements WorkspaceAdapter {
  prepareError?: Error;
  async preflight(_ticket: Ticket) {}
  async plan(ticket: Ticket) {
    return { ticket: ticket.ref, path: "/work", branch: "task/A" };
  }
  async prepare() {
    if (this.prepareError) throw this.prepareError;
    return { path: "/work", branch: "task/A" };
  }
}

class FakeHarness implements HarnessAdapter {
  launchError?: Error;
  stopError?: Error;
  stopped = false;
  describedCapabilities = capabilities();
  preflightRequest?: Parameters<HarnessAdapter["preflight"]>[0];
  launchRequest?: Parameters<HarnessAdapter["launch"]>[0];
  async describe() {
    return this.describedCapabilities;
  }
  async preflight(request: Parameters<HarnessAdapter["preflight"]>[0]) {
    this.preflightRequest = request;
  }
  async launch(request: Parameters<HarnessAdapter["launch"]>[0]): Promise<LaunchReceipt> {
    this.launchRequest = request;
    if (this.launchError) throw this.launchError;
    return { sessionId: "s", tier: "launch" };
  }
  async stop() {
    this.stopped = true;
    if (this.stopError) throw this.stopError;
  }
}

const request = {
  ticket: ticketRefSchema.parse("jira:x:W:ticket:A"),
  owner: actorRefSchema.parse("human"),
  harness: adapterRefSchema.parse("codex"),
};

function coordinator(
  tracker = new FakeTracker(),
  workspace = new FakeWorkspace(),
  harness = new FakeHarness(),
) {
  const ledger = new FakeLedger();
  const claimLock = new FakeLock();
  return {
    claimLock,
    tracker,
    workspace,
    harness,
    ledger,
    coordinator: new PickupCoordinator({
      tracker,
      claimLock,
      workspace,
      harness,
      ledger,
      ids: {
        run: () => runRefSchema.parse("interlock-run:test"),
        claim: () => claimRefSchema.parse("interlock-claim:test"),
      },
      clock: { now: () => new Date("2026-08-10T12:00:00Z") },
    }),
  };
}

async function failure(subject: PickupCoordinator): Promise<PickupResultError> {
  try {
    await subject.execute(request);
    throw new Error("Expected pickup to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PickupResultError);
    return z.instanceof(PickupResultError).parse(error);
  }
}

describe("pickup coordinator", () => {
  test("commits a verified pickup with a default 15-minute lease", async () => {
    const { coordinator: subject, ledger, claimLock } = coordinator();
    expect(await subject.execute(request)).toMatchObject({ ok: true, state: "committed" });
    expect(claimLock.claimRequest?.leaseExpiresAt).toBe("2026-08-10T12:15:00.000Z");
    expect(ledger.committedClaim).toEqual({
      ref: claimRefSchema.parse("interlock-claim:test"),
      ticket: request.ticket,
      humanOwner: request.owner,
      run: runRefSchema.parse("interlock-run:test"),
      previousState: {
        version: "absent",
        payload: {
          lock: { version: "absent", record: null },
          tracker: { version: "1", payload: { assignee: null, status: "To Do" } },
        },
      },
      claimedAt: "2026-08-10T12:00:00.000Z",
      leaseExpiresAt: "2026-08-10T12:15:00.000Z",
      status: "active",
      currentVersion: "1",
    });
    expect(ledger.steps).toEqual([
      "planning",
      "claiming",
      "claimed",
      "workspace_prepared",
      "launched",
      "committed",
    ]);
  });

  test("preflight failure performs no tracker mutation", async () => {
    const tracker = new FakeTracker();
    tracker.preflightError = new Error("unsupported");
    const { coordinator: subject } = coordinator(tracker);
    await expect(subject.execute(request)).rejects.toThrow("unsupported");
    expect(tracker.claimCalls).toBe(0);
    expect(tracker.restoreCalls).toBe(0);
  });

  test("an unverified lock capability fails before any write", async () => {
    const item = coordinator();
    Object.assign(item.claimLock, { describe: async () => ({}) });
    await expect(item.coordinator.execute(request)).rejects.toThrow(
      "Unsupported capabilities: conditional_update",
    );
    expect(item.tracker.claimCalls).toBe(0);
    expect(item.claimLock.claimRequest).toBeUndefined();
  });

  test("requested routing capabilities are rejected before claim", async () => {
    const harness = new FakeHarness();
    harness.describedCapabilities = capabilities("model_selection");
    const {
      coordinator: subject,
      tracker,
      workspace,
    } = coordinator(new FakeTracker(), new FakeWorkspace(), harness);
    await expect(
      subject.execute({
        ...request,
        model: "gpt",
        effort: "high",
        context: "repo",
        requiredCapabilities: capabilities("workspace_prepare"),
      }),
    ).rejects.toThrow(
      "Unsupported capabilities: reasoning_selection, context_selection, workspace_prepare",
    );
    expect(tracker.claimCalls).toBe(0);
    expect(workspace).toBeDefined();
    expect(harness.preflightRequest).toBeUndefined();
  });

  test("validated routing settings reach preflight, launch, and the run ledger", async () => {
    const harness = new FakeHarness();
    harness.describedCapabilities = capabilities(
      "model_selection",
      "reasoning_selection",
      "context_selection",
    );
    const { coordinator: subject, ledger } = coordinator(
      new FakeTracker(),
      new FakeWorkspace(),
      harness,
    );
    await subject.execute({
      ...request,
      model: "gpt",
      effort: "high",
      context: "repo",
    });
    expect(harness.preflightRequest).toMatchObject({
      model: "gpt",
      effort: "high",
      context: "repo",
    });
    expect(harness.launchRequest).toMatchObject({
      model: "gpt",
      effort: "high",
      context: "repo",
    });
    expect(ledger.savedRun).toMatchObject({
      model: "gpt",
      effort: "high",
      context: "repo",
      capabilities: harness.describedCapabilities,
      status: "active",
    });
  });

  test("definite claim collision does not compensate", async () => {
    const tracker = new FakeTracker();
    const { coordinator: subject, ledger, claimLock } = coordinator(tracker);
    claimLock.claimError = new ClaimCollisionError();
    expect((await failure(subject)).receipt.state).toBe("collision");
    expect(tracker.restoreCalls).toBe(0);
    expect(ledger.steps).toEqual(["planning", "claiming", "collision"]);
  });

  test("ambiguous claim failure compensates the exact snapshot", async () => {
    const tracker = new FakeTracker();
    const { coordinator: subject, claimLock } = coordinator(tracker);
    claimLock.claimError = new AmbiguousTrackerResultError();
    expect((await failure(subject)).receipt.state).toBe("compensated");
    expect(tracker.restoreRequest).toEqual({
      ticket: request.ticket,
      claim: "interlock-claim:test",
      claimedOwner: request.owner,
      originalSnapshot: { version: "1", payload: { assignee: null, status: "To Do" } },
    });
  });

  test("post-mutation claim verification collision compensates", async () => {
    const tracker = new FakeTracker();
    tracker.verifyClaimError = new ClaimCollisionError("claim changed before verification");
    const { coordinator: subject } = coordinator(tracker);
    expect((await failure(subject)).receipt.state).toBe("compensated");
    expect(tracker.restoreCalls).toBe(1);
  });

  test("workspace failure compensates", async () => {
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    const { coordinator: subject, tracker } = coordinator(new FakeTracker(), workspace);
    expect((await failure(subject)).receipt.state).toBe("compensated");
    expect(tracker.restoreCalls).toBe(1);
  });

  test("ledger failure while entering compensation does not strand the tracker claim", async () => {
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    const item = coordinator(new FakeTracker(), workspace);
    item.ledger.recordStepErrorState = "compensating";
    item.ledger.recordStepError = new Error("ledger unavailable");

    const result = await failure(item.coordinator);

    expect(item.tracker.restoreCalls).toBe(1);
    expect(result.receipt.state).toBe("recovery_required");
    expect(item.ledger.recoveryRun?.status).toBe("recovery_required");
  });

  test("final compensated-step persistence failure is durably recovery-required", async () => {
    const directory = mkdtempSync(join(tmpdir(), "interlock-test-"));
    const store = new FailingCompensatedStateStore(join(directory, "interlock.db"));
    const tracker = new FakeTracker();
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    const subject = new PickupCoordinator({
      tracker,
      claimLock: new FakeLock(),
      workspace,
      harness: new FakeHarness(),
      ledger: store,
      ids: {
        run: () => runRefSchema.parse("interlock-run:test"),
        claim: () => claimRefSchema.parse("interlock-claim:test"),
      },
      clock: { now: () => new Date("2026-08-10T12:00:00Z") },
    });

    try {
      const result = await failure(subject);

      expect(tracker.restoreCalls).toBe(1);
      expect(result.receipt).toMatchObject({
        state: "recovery_required",
        recoveryCommand: "interlock runs export interlock-run:test",
      });
      expect(result.cause).toBeInstanceOf(AggregateError);
      const error = z.instanceof(AggregateError).parse(result.cause);
      expect(error.message).toBe("Pickup compensation could not be fully verified");
      expect(error.errors).toEqual([workspace.prepareError, store.compensatedStepError]);
      expect(store.run(runRefSchema.parse("interlock-run:test")).status).toBe("recovery_required");
      expect(store.claim(claimRefSchema.parse("interlock-claim:test")).status).toBe("active");
      expect(store.steps(runRefSchema.parse("interlock-run:test")).at(-1)).toMatchObject({
        state: "recovery_required",
        error_text: "Pickup compensation could not be fully verified",
      });
      expect(store.recoveryEvidence(runRefSchema.parse("interlock-run:test"))).toEqual([
        expect.objectContaining({
          outcome: "verification_required",
          evidence_json: JSON.stringify({
            command: "interlock runs export interlock-run:test",
            tracker: "restored_verified",
            session: "not_started",
            ledger: "compensated_step_persistence_failed",
          }),
        }),
      ]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("restoration verification failure requires recovery", async () => {
    const tracker = new FakeTracker();
    tracker.verifyRestoreError = new Error("cannot verify");
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    const item = coordinator(tracker, workspace);
    const result = await failure(item.coordinator);
    expect(result.receipt.state).toBe("recovery_required");
    expect(result.receipt.recoveryCommand).toBe("interlock runs export interlock-run:test");
    expect(item.ledger.recoveryRun?.status).toBe("recovery_required");
  });

  test("recovery ledger failure remains explicit after best-effort remote compensation", async () => {
    const tracker = new FakeTracker();
    tracker.verifyRestoreError = new Error("cannot verify restoration");
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    const item = coordinator(tracker, workspace);
    const ledgerError = new Error("recovery ledger unavailable");
    item.ledger.saveRecoveryRequiredError = ledgerError;

    const result = await failure(item.coordinator);

    expect(item.tracker.restoreCalls).toBe(1);
    expect(result.receipt.state).toBe("recovery_required");
    expect(result.cause).toBeInstanceOf(AggregateError);
    const outer = z.instanceof(AggregateError).parse(result.cause);
    expect(outer.message).toBe(
      "Pickup requires recovery and its recovery ledger could not be persisted",
    );
    expect(outer.errors).toHaveLength(2);
    expect(outer.errors[0]).toBeInstanceOf(AggregateError);
    expect(z.instanceof(AggregateError).parse(outer.errors[0]).message).toBe(
      "Pickup compensation could not be fully verified",
    );
    expect(z.instanceof(AggregateError).parse(outer.errors[0]).errors).toEqual([
      workspace.prepareError,
      tracker.verifyRestoreError,
    ]);
    expect(outer.errors[1]).toBe(ledgerError);
  });

  test("concurrent change during restoration requires recovery", async () => {
    const tracker = new FakeTracker();
    tracker.restoreError = new ClaimCollisionError("human changed the ticket");
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    expect((await failure(coordinator(tracker, workspace).coordinator)).receipt.state).toBe(
      "recovery_required",
    );
  });

  test("launch failure restores the tracker claim", async () => {
    const harness = new FakeHarness();
    harness.launchError = new Error("launch failed");
    const { coordinator: subject, tracker } = coordinator(
      new FakeTracker(),
      new FakeWorkspace(),
      harness,
    );
    expect((await failure(subject)).receipt.state).toBe("compensated");
    expect(tracker.restoreCalls).toBe(1);
  });

  test("uncertain partial launch stop still restores tracker and requires recovery", async () => {
    const harness = new FakeHarness();
    harness.launchError = new HarnessLaunchError("launch response lost", {
      sessionId: "partial",
      tier: "launch",
    });
    harness.stopError = new Error("cannot verify stop");
    const { coordinator: subject, tracker } = coordinator(
      new FakeTracker(),
      new FakeWorkspace(),
      harness,
    );
    expect((await failure(subject)).receipt.state).toBe("recovery_required");
    expect(harness.stopped).toBeTrue();
    expect(tracker.restoreCalls).toBe(1);
  });
});
