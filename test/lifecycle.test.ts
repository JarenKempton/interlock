import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ProcessLifecycleAdapter } from "../src/adapters/harnesses/process-lifecycle.ts";
import { run as runCli } from "../src/cli.ts";
import type {
  ClaimRequest,
  ReclaimRequest,
  ReleaseClaimRequest,
  RenewLeaseRequest,
  RestoreClaimRequest,
  RunLifecycleAdapter,
  TrackerAdapter,
} from "../src/domain/contracts.ts";
import { actorRefSchema, adapterRefSchema, ticketRefSchema } from "../src/domain/identifiers.ts";
import type { Claim, Run, Ticket, TicketRef, TrackerSnapshot } from "../src/domain/model.ts";
import { capabilities } from "../src/domain/model.ts";
import {
  LifecycleCoordinator,
  Supervisor,
  type SupervisorHeartbeatScheduler,
} from "../src/execution/lifecycle.ts";
import { StateStore } from "../src/persistence/state.ts";

class Tracker implements TrackerAdapter {
  renewError?: Error;
  verifyRenewError?: Error;
  releaseError?: Error;
  verifyReleaseError?: Error;
  renewed: RenewLeaseRequest[] = [];
  released?: ReleaseClaimRequest;
  async describe() {
    return capabilities("lease_metadata");
  }
  async preflight() {}
  async getTicket(): Promise<Ticket> {
    throw new Error("unused");
  }
  async snapshotClaimState(_ticket: TicketRef): Promise<TrackerSnapshot> {
    return { version: "3", payload: {} };
  }
  async claim(_request: ClaimRequest) {}
  async verifyClaim(_request: ClaimRequest) {}
  async restoreClaimState(_request: RestoreClaimRequest) {}
  async verifyRestored(_request: RestoreClaimRequest) {}
  async renewLease(request: RenewLeaseRequest) {
    this.renewed.push(request);
    if (this.renewError) throw this.renewError;
  }
  async verifyLease(_request: RenewLeaseRequest) {
    if (this.verifyRenewError) throw this.verifyRenewError;
  }
  async releaseClaim(request: ReleaseClaimRequest) {
    this.released = request;
    if (this.releaseError) throw this.releaseError;
  }
  async verifyReleased(_request: ReleaseClaimRequest) {
    if (this.verifyReleaseError) throw this.verifyReleaseError;
  }
  async reclaim(_request: ReclaimRequest) {}
  async verifyReclaimed(_request: ReclaimRequest) {}
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "interlock-lifecycle-"));
  const store = new StateStore(join(directory, "state.db"));
  const makeRun = (id: string): Run => ({
    ref: `interlock-run:${id}`,
    ticket: ticketRefSchema.parse(`jira:x:W:ticket:${id}`),
    harness: adapterRefSchema.parse("fake"),
    workspace: { path: `/kept/${id}` },
    capabilities: capabilities("session_status", "session_interrupt"),
    status: "active",
    createdAt: `2026-08-10T12:00:0${id === "a" ? "0" : "1"}.000Z`,
    updatedAt: "2026-08-10T12:00:00.000Z",
    execution: { sessionId: `session-${id}`, tier: "managed" },
  });
  const add = (id: string, claimStatus: Claim["status"] = "active") => {
    const run = makeRun(id);
    const claim: Claim = {
      ref: `interlock-claim:${id}`,
      ticket: run.ticket,
      humanOwner: actorRefSchema.parse("human"),
      run: run.ref,
      previousState: { version: "1", payload: { status: "To Do" } },
      claimedAt: run.createdAt,
      leaseExpiresAt: "2026-08-10T12:15:00.000Z",
      status: claimStatus,
      currentVersion: "2",
    };
    store.saveRun(run);
    store.saveClaim(claim);
    return { run, claim };
  };
  const addRunOnly = (id: string) => {
    const run = makeRun(id);
    store.saveRun(run);
    return { run };
  };
  const cleanup = () => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { store, add, addRunOnly, cleanup };
}

function lifecycle(overrides: Partial<RunLifecycleAdapter> = {}): RunLifecycleAdapter {
  return {
    capabilities: capabilities("session_status", "session_interrupt"),
    observe: async () => ({ state: "running", observedAt: "2026-08-10T12:05:00.000Z" }),
    stop: async () => {},
    ...overrides,
  };
}

function supervisor(
  store: StateStore,
  tracker: Tracker,
  select: (run: Run) => RunLifecycleAdapter = () => lifecycle(),
  extra = {},
) {
  return new Supervisor({
    store,
    tracker,
    lifecycle: select,
    clock: { now: () => new Date("2026-08-10T12:05:00.000Z") },
    supervisorId: "test-supervisor",
    ...extra,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class ManualHeartbeat implements SupervisorHeartbeatScheduler {
  callback?: () => void;
  intervalMs?: number;
  stopped = false;

  start(callback: () => void, intervalMs: number): () => void {
    this.callback = callback;
    this.intervalMs = intervalMs;
    return () => {
      this.stopped = true;
    };
  }

  fire(): void {
    if (!this.callback) throw new Error("Heartbeat has not started");
    this.callback();
  }
}

describe("supervisor", () => {
  test("renews only an active run with an active claim", async () => {
    const item = fixture();
    const { run, claim } = item.add("a");
    const tracker = new Tracker();
    try {
      expect(await supervisor(item.store, tracker).tick()).toEqual([
        { run: run.ref, outcome: "renewed" },
      ]);
      expect(item.store.claim(claim.ref)).toMatchObject({ currentVersion: "3" });
    } finally {
      item.cleanup();
    }
  });

  test("released or superseded claims are never renewed", async () => {
    const item = fixture();
    const released = item.add("a", "released");
    const superseded = item.add("b", "superseded");
    const tracker = new Tracker();
    try {
      await supervisor(item.store, tracker).tick();
      expect(tracker.renewed).toEqual([]);
      expect(item.store.run(released.run.ref).status).toBe("attention_required");
      expect(item.store.run(superseded.run.ref).status).toBe("attention_required");
    } finally {
      item.cleanup();
    }
  });

  test("persisted active claim is stale at expiry and after restart downtime", async () => {
    const item = fixture();
    const { run } = item.add("a");
    const tracker = new Tracker();
    try {
      for (const now of ["2026-08-10T12:15:00.000Z", "2026-08-10T12:20:00.000Z"]) {
        const restarted = item.store.run(run.ref);
        restarted.status = "active";
        item.store.saveRun(restarted);
        await supervisor(item.store, tracker, () => lifecycle(), {
          clock: { now: () => new Date(now) },
        }).tick();
        expect(tracker.renewed).toEqual([]);
        expect(item.store.run(run.ref).status).toBe("attention_required");
      }
    } finally {
      item.cleanup();
    }
  });

  test("claim expiring during observation is rejected by the final pre-renewal check", async () => {
    const item = fixture();
    const { run } = item.add("a");
    const tracker = new Tracker();
    const times = [
      new Date("2026-08-10T12:14:59.000Z"),
      new Date("2026-08-10T12:14:59.500Z"),
      new Date("2026-08-10T12:15:00.000Z"),
    ];
    try {
      await supervisor(item.store, tracker, () => lifecycle(), {
        clock: { now: () => times.shift() ?? new Date("2026-08-10T12:15:00.000Z") },
      }).tick();
      expect(tracker.renewed).toEqual([]);
      expect(item.store.run(run.ref).status).toBe("attention_required");
    } finally {
      item.cleanup();
    }
  });

  test("explicit reclaimed identity may renew after restart downtime", async () => {
    const item = fixture();
    const { claim } = item.add("a");
    const reclaimed: Claim = {
      ...claim,
      ref: "interlock-claim:reclaimed",
      claimedAt: "2026-08-10T12:19:00.000Z",
      leaseExpiresAt: "2026-08-10T12:30:00.000Z",
      currentVersion: "4",
      supersedes: claim.ref,
    };
    claim.status = "superseded";
    claim.supersededBy = reclaimed.ref;
    item.store.saveClaim(claim);
    item.store.saveClaim(reclaimed);
    const tracker = new Tracker();
    try {
      await supervisor(item.store, tracker, () => lifecycle(), {
        clock: { now: () => new Date("2026-08-10T12:20:00.000Z") },
      }).tick();
      expect(tracker.renewed.map((request) => request.claim)).toEqual([reclaimed.ref]);
    } finally {
      item.cleanup();
    }
  });

  test("observe failure for run A is isolated while run B renews", async () => {
    const item = fixture();
    const a = item.add("a");
    const b = item.add("b");
    const tracker = new Tracker();
    try {
      const result = await supervisor(item.store, tracker, (run) =>
        run.ref === a.run.ref
          ? lifecycle({
              observe: async () => {
                throw new Error("observe failed");
              },
            })
          : lifecycle(),
      ).tick();
      expect(result).toEqual([
        { run: a.run.ref, outcome: "attention_required" },
        { run: b.run.ref, outcome: "renewed" },
      ]);
      expect(tracker.renewed.map((request) => request.claim)).toEqual([b.claim.ref]);
    } finally {
      item.cleanup();
    }
  });

  test("active run without a claim is isolated and marked for attention", async () => {
    const item = fixture();
    const a = item.addRunOnly("a");
    const b = item.add("b");
    const tracker = new Tracker();
    try {
      await supervisor(item.store, tracker).tick();
      expect(item.store.run(a.run.ref).status).toBe("attention_required");
      expect(tracker.renewed.map((request) => request.claim)).toEqual([b.claim.ref]);
    } finally {
      item.cleanup();
    }
  });

  test("PID-only identity mismatch never renews an unrelated process", async () => {
    const item = fixture();
    const { run } = item.add("a");
    run.execution = { pid: process.pid, processIdentity: "different-process", tier: "launch" };
    item.store.saveRun(run);
    const tracker = new Tracker();
    try {
      await supervisor(item.store, tracker, () => new ProcessLifecycleAdapter()).tick();
      expect(tracker.renewed).toEqual([]);
      expect(item.store.run(run.ref).status).toBe("attention_required");
    } finally {
      item.cleanup();
    }
  });

  test("lock releases after success and isolated failure", async () => {
    const item = fixture();
    item.add("a");
    try {
      await supervisor(item.store, new Tracker()).tick();
      expect(item.store.supervisorStatus()).toBeUndefined();
      const run = item.store.run("interlock-run:a");
      run.status = "active";
      item.store.saveRun(run);
      await supervisor(item.store, new Tracker(), () =>
        lifecycle({
          observe: async () => {
            throw new Error("bad");
          },
        }),
      ).tick();
      expect(item.store.supervisorStatus()).toBeUndefined();
    } finally {
      item.cleanup();
    }
  });

  test("heartbeat prevents a long tick from overlapping", async () => {
    const item = fixture();
    item.add("a");
    const entered = deferred();
    const blocked = deferred();
    const heartbeat = new ManualHeartbeat();
    let lockNow = new Date("2026-08-10T12:00:00.000Z");
    let first: Promise<Array<{ run: Run["ref"]; outcome: string }>> | undefined;
    try {
      first = supervisor(
        item.store,
        new Tracker(),
        () =>
          lifecycle({
            observe: async () => {
              entered.resolve();
              await blocked.promise;
              return { state: "running", observedAt: new Date().toISOString() };
            },
          }),
        {
          supervisorId: "first",
          supervisorLockMs: 30,
          lockClock: () => lockNow,
          heartbeatScheduler: heartbeat,
        },
      ).tick();
      await entered.promise;
      expect(heartbeat.intervalMs).toBe(10);

      lockNow = new Date("2026-08-10T12:00:00.020Z");
      heartbeat.fire();
      expect(item.store.supervisorStatus()).toEqual({
        owner: "first",
        heartbeat_at: "2026-08-10T12:00:00.020Z",
        expires_at: "2026-08-10T12:00:00.050Z",
      });

      lockNow = new Date("2026-08-10T12:00:00.031Z");
      await expect(
        supervisor(item.store, new Tracker(), () => lifecycle(), {
          supervisorId: "second",
          supervisorLockMs: 30,
          lockClock: () => lockNow,
          heartbeatScheduler: new ManualHeartbeat(),
        }).tick(),
      ).rejects.toThrow("Another per-user supervisor");
      blocked.resolve();
      await first;
      expect(heartbeat.stopped).toBeTrue();
      expect(item.store.supervisorStatus()).toBeUndefined();
    } finally {
      blocked.resolve();
      await first?.catch(() => undefined);
      item.cleanup();
    }
  });

  test("same-process supervisor identity cannot overlap an unexpired tick", async () => {
    const item = fixture();
    item.add("a");
    const entered = deferred();
    const blocked = deferred();
    let first: Promise<Array<{ run: Run["ref"]; outcome: string }>> | undefined;
    try {
      first = supervisor(
        item.store,
        new Tracker(),
        () =>
          lifecycle({
            observe: async () => {
              entered.resolve();
              await blocked.promise;
              return { state: "running", observedAt: "now" };
            },
          }),
        { supervisorId: "same-process", supervisorLockMs: 1_000 },
      ).tick();
      await entered.promise;
      await expect(
        supervisor(item.store, new Tracker(), () => lifecycle(), {
          supervisorId: "same-process",
          supervisorLockMs: 1_000,
        }).tick(),
      ).rejects.toThrow("Another per-user supervisor");
      blocked.resolve();
      await first;
    } finally {
      blocked.resolve();
      await first?.catch(() => undefined);
      item.cleanup();
    }
  });

  test("renew failure is isolated and an ambiguous crash window reconciles on restart", async () => {
    const item = fixture();
    const a = item.add("a");
    const failing = new Tracker();
    failing.renewError = new Error("renew failed");
    failing.verifyRenewError = new Error("not applied");
    try {
      await supervisor(item.store, failing).tick();
      expect(item.store.run(a.run.ref).status).toBe("attention_required");

      const reset = item.store.run(a.run.ref);
      reset.status = "active";
      item.store.saveRun(reset);
      const applied = new Tracker();
      await supervisor(item.store, applied, () => lifecycle(), {
        afterRenewVerified: () => {
          throw new Error("simulated process crash");
        },
      }).tick();
      expect(item.store.supervisorStatus()).toBeUndefined();
      expect(item.store.pendingRenewals()).toHaveLength(1);
      expect((await supervisor(item.store, new Tracker()).tick())[0]?.outcome).toBe(
        "renewal_reconciled",
      );
      expect(item.store.pendingRenewals()).toHaveLength(0);
      expect(item.store.run(a.run.ref).status).toBe("active");
    } finally {
      item.cleanup();
    }
  });
});

describe("lifecycle coordinator", () => {
  test("missing managed adapter fails before mutation", async () => {
    const item = fixture();
    const { run } = item.add("a");
    try {
      const coordinator = new LifecycleCoordinator(
        item.store,
        new Tracker(),
        () => {
          throw new Error("adapter missing");
        },
        { now: () => new Date() },
      );
      await expect(coordinator.stop(run.ref)).rejects.toThrow("adapter missing");
      expect(item.store.run(run.ref)).toEqual(run);
    } finally {
      item.cleanup();
    }
  });

  test("bare PID identity never observes, signals, or mutates a run", async () => {
    const item = fixture();
    const { run } = item.add("a");
    run.execution = { pid: process.pid, tier: "launch" };
    item.store.saveRun(run);
    try {
      const coordinator = new LifecycleCoordinator(
        item.store,
        undefined,
        () => new ProcessLifecycleAdapter(),
        { now: () => new Date() },
      );
      await expect(coordinator.stop(run.ref)).rejects.toThrow("Unsupported capabilities");
      expect(item.store.run(run.ref).status).toBe("active");
    } finally {
      item.cleanup();
    }
  });

  test("stop is recorded only after observed termination", async () => {
    const item = fixture();
    const { run } = item.add("a");
    try {
      const good = new LifecycleCoordinator(
        item.store,
        undefined,
        () => lifecycle({ observe: async () => ({ state: "stopped", observedAt: "now" }) }),
        { now: () => new Date("2026-08-10T12:06:00Z") },
      );
      expect((await good.stop(run.ref)).status).toBe("stopped");
    } finally {
      item.cleanup();
    }
  });

  test("failed stop remains non-stopped and requires recovery", async () => {
    const item = fixture();
    const { run } = item.add("a");
    try {
      const coordinator = new LifecycleCoordinator(
        item.store,
        undefined,
        () => lifecycle({ observe: async () => ({ state: "running", observedAt: "now" }) }),
        { now: () => new Date() },
      );
      await expect(coordinator.stop(run.ref)).rejects.toThrow("Stop could not be verified");
      expect(item.store.run(run.ref).status).toBe("recovery_required");
      expect(item.store.run(run.ref).status).not.toBe("stopped");
    } finally {
      item.cleanup();
    }
  });

  test("failed release is persisted as recovery required", async () => {
    const item = fixture();
    const { run, claim } = item.add("a");
    const tracker = new Tracker();
    tracker.releaseError = new Error("release failed");
    try {
      const coordinator = new LifecycleCoordinator(item.store, tracker, () => lifecycle(), {
        now: () => new Date(),
      });
      await expect(coordinator.release(claim.ref, claim.humanOwner)).rejects.toThrow(
        "release failed",
      );
      expect(item.store.run(run.ref).status).toBe("recovery_required");
      expect(item.store.claim(claim.ref).status).toBe("active");
    } finally {
      item.cleanup();
    }
  });

  test("failed release verification preserves the active claim", async () => {
    const item = fixture();
    const { run, claim } = item.add("a");
    const tracker = new Tracker();
    tracker.verifyReleaseError = new Error("release verification failed");
    try {
      const coordinator = new LifecycleCoordinator(item.store, tracker, () => lifecycle(), {
        now: () => new Date(),
      });
      await expect(coordinator.release(claim.ref, claim.humanOwner)).rejects.toThrow(
        "release verification failed",
      );
      expect(item.store.run(run.ref).status).toBe("recovery_required");
      expect(item.store.claim(claim.ref).status).toBe("active");
    } finally {
      item.cleanup();
    }
  });

  test("attention has an explicit verified reconciliation path", () => {
    const item = fixture();
    const { run, claim } = item.add("a");
    run.status = "attention_required";
    item.store.saveRun(run);
    try {
      const coordinator = new LifecycleCoordinator(item.store, new Tracker(), () => lifecycle(), {
        now: () => new Date(),
      });
      const result = coordinator.reconcileAttention(
        run.ref,
        { state: "running", observedAt: "verified" },
        claim,
      );
      expect(result.status).toBe("active");
    } finally {
      item.cleanup();
    }
  });

  test("failed recovery verification is recorded and never resolves the run", async () => {
    const item = fixture();
    const { run } = item.add("a");
    run.status = "recovery_required";
    item.store.saveRun(run);
    try {
      const coordinator = new LifecycleCoordinator(item.store, new Tracker(), () => lifecycle(), {
        now: () => new Date(),
      });
      const result = await coordinator.recover(run.ref, { checked: "tracker" }, async () => ({
        verified: false,
        evidence: { mismatch: true },
      }));
      expect(result.status).toBe("recovery_required");
      expect(item.store.recoveryEvidence(run.ref)).toHaveLength(1);
    } finally {
      item.cleanup();
    }
  });

  test("standalone CLI does not advertise or execute unwired lifecycle commands", async () => {
    const directory = mkdtempSync(join(tmpdir(), "interlock-recovery-"));
    const statePath = join(directory, "state.db");
    const store = new StateStore(statePath);
    const run: Run = {
      ref: "interlock-run:cli",
      ticket: ticketRefSchema.parse("jira:x:W:ticket:CLI"),
      harness: adapterRefSchema.parse("fake"),
      workspace: { path: "/kept" },
      capabilities: capabilities(),
      status: "recovery_required",
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    };
    store.saveRun(run);
    store.close();
    try {
      const output: string[] = [];
      await runCli(["help"], (line) => output.push(line), { statePath });
      expect(output.join("\n")).not.toContain("interlock recover");
      expect(output.join("\n")).not.toContain("interlock stop");
      await expect(
        runCli(["recover", run.ref, "--evidence", "{}"], () => {}, { statePath }),
      ).rejects.toThrow("no recovery verifier is composed");
      const reopened = new StateStore(statePath);
      expect(reopened.run(run.ref).status).toBe("recovery_required");
      expect(reopened.recoveryEvidence(run.ref)).toHaveLength(0);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test.each(["expired claim", "released claim", "superseded claim", "expired intent"])(
  "stale renewal retirement preserves evidence and does not churn on later ticks: %s",
  async (scenario) => {
    const item = fixture();
    const { run, claim } = item.add("a");
    const request: RenewLeaseRequest = {
      claim: claim.ref,
      ticket: claim.ticket,
      expectedVersion: "2",
      leaseExpiresAt: "2026-08-10T12:20:00.000Z",
    };
    if (scenario === "expired claim") claim.leaseExpiresAt = "2026-08-10T12:04:00.000Z";
    if (scenario === "released claim") claim.status = "released";
    if (scenario === "superseded claim") claim.status = "superseded";
    if (scenario === "expired intent") request.leaseExpiresAt = "2026-08-10T12:04:00.000Z";
    item.store.saveClaim(claim);
    item.store.beginRenewal(run.ref, claim.ref, request, run.createdAt);
    const tracker = new Tracker();
    try {
      expect(await supervisor(item.store, tracker).tick()).toEqual([
        { run: run.ref, outcome: "attention_required" },
      ]);
      expect(item.store.pendingRenewals()).toEqual([]);
      const steps = item.store.steps(run.ref);
      expect(steps).toHaveLength(1);
      expect(
        JSON.parse(z.object({ receipt_json: z.string() }).parse(steps[0]).receipt_json),
      ).toEqual({ phase: "renewal_reconciliation", request });
      expect(await supervisor(item.store, tracker).tick()).toEqual([]);
      expect(await supervisor(item.store, tracker).tick()).toEqual([]);
      expect(item.store.steps(run.ref)).toEqual(steps);
      expect(item.store.run(run.ref).status).toBe("attention_required");
      expect(item.store.run(run.ref).workspace).toEqual(run.workspace);
      expect(item.store.claim(claim.ref)).toEqual(claim);
      expect(tracker.renewed).toEqual([]);
    } finally {
      item.cleanup();
    }
  },
);

test("failed renewal retirement preserves both the pending intent and original run", () => {
  const item = fixture();
  const { run, claim } = item.add("a");
  const request: RenewLeaseRequest = {
    claim: claim.ref,
    ticket: claim.ticket,
    expectedVersion: "2",
    leaseExpiresAt: claim.leaseExpiresAt,
  };
  item.store.beginRenewal(run.ref, claim.ref, request, run.createdAt);
  const recordStep = item.store.recordStep;
  try {
    item.store.recordStep = () => {
      throw new Error("simulated receipt write failure");
    };
    expect(() =>
      item.store.retireRenewal(
        { ...run, status: "attention_required" },
        request,
        new Error("Claim is stale"),
      ),
    ).toThrow("simulated receipt write failure");
    expect(item.store.run(run.ref)).toEqual(run);
    expect(item.store.pendingRenewals()).toEqual([{ run: run.ref, claim: claim.ref, request }]);
    expect(item.store.steps(run.ref)).toEqual([]);
  } finally {
    item.store.recordStep = recordStep;
    item.cleanup();
  }
});
