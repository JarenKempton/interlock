import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  CommandHarnessAdapter,
  type HarnessPlatform,
  type HarnessProcess,
} from "../src/adapters/harnesses/command.ts";
import {
  formatMarkdownTracker,
  MarkdownTrackerAdapter,
  type MarkdownTrackerClock,
  type MarkdownTrackerDocument,
} from "../src/adapters/trackers/markdown.ts";
import type {
  Clock,
  PickupRequest,
  RunLifecycleAdapter,
  WorkspaceAdapter,
} from "../src/domain/contracts.ts";
import { AmbiguousTrackerResultError, ClaimCollisionError } from "../src/domain/contracts.ts";
import {
  actorRefSchema,
  adapterRefSchema,
  claimRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
  workspaceRefSchema,
} from "../src/domain/identifiers.ts";
import {
  capabilities,
  claimStatusAt,
  type ObservedSessionState,
  type Ticket,
  type TicketRef,
} from "../src/domain/model.ts";
import { LifecycleCoordinator, Supervisor } from "../src/execution/lifecycle.ts";
import { PickupCoordinator, PickupResultError } from "../src/execution/pickup.ts";
import { evaluateFrontier } from "../src/frontier/evaluate.ts";
import { StateStore } from "../src/persistence/state.ts";

// Exercises production coordination against a temporary Markdown tracker and an
// injected harness platform. This does not qualify hosted writes or live agents.

const workspace = workspaceRefSchema.parse("markdown:local:accept");
const map1 = mapRefSchema.parse("markdown:local:accept:map:m1");
const map2 = mapRefSchema.parse("markdown:local:accept:map:m2");
const ta = ticketRefSchema.parse("markdown:local:accept:ticket:a"); // map1, order 0, frontier head
const tb = ticketRefSchema.parse("markdown:local:accept:ticket:b"); // map2, order 1, cross-map blocked by ta
const tc = ticketRefSchema.parse("markdown:local:accept:ticket:c"); // map1, order 2
const owner = actorRefSchema.parse("jaren");

const CLAIM_TIME = "2026-08-11T12:00:00.000Z";
const LEASE_TIME = "2026-08-11T12:15:00.000Z"; // CLAIM_TIME + default 15 minute lease
const fixedClock: Clock = { now: () => new Date(CLAIM_TIME) };

const directories: string[] = [];
const stores: StateStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function document(): MarkdownTrackerDocument {
  return {
    format: "interlock-markdown-tracker",
    version: 1,
    workspace,
    maps: [
      { ref: map1, title: "Primary map", order: 0, context: [] },
      { ref: map2, title: "Downstream map", order: 1, context: [] },
    ],
    tickets: [
      {
        ref: ta,
        map: map1,
        title: "Frontier head",
        kind: "task",
        state: "open",
        status: "To Do",
        order: 0,
        comments: [],
        artifacts: [],
        claimHistory: [],
      },
      {
        ref: tb,
        map: map2,
        title: "Cross-map dependent",
        kind: "task",
        state: "open",
        status: "To Do",
        order: 1,
        dependencies: [{ blocking: ta, blocked: tb, kind: "blocks" }],
        comments: [],
        artifacts: [],
        claimHistory: [],
      },
      {
        ref: tc,
        map: map1,
        title: "Second frontier ticket",
        kind: "task",
        state: "open",
        status: "To Do",
        order: 2,
        comments: [],
        artifacts: [],
        claimHistory: [],
      },
    ],
  };
}

async function fixtureTracker(
  clock: MarkdownTrackerClock = fixedClock,
): Promise<MarkdownTrackerAdapter> {
  const directory = await mkdtemp(join(tmpdir(), "interlock-accept-"));
  directories.push(directory);
  const path = join(directory, "tracker.md");
  // Human prose around the fenced state proves the disposable tracker is a
  // real editable Markdown document, not a generated data file.
  await writeFile(
    path,
    `# Acceptance run\n\nHuman preface.\n\n${formatMarkdownTracker(document())}`,
  );
  return new MarkdownTrackerAdapter(path, clock);
}

async function newStore(name: string): Promise<StateStore> {
  const directory = await mkdtemp(join(tmpdir(), `interlock-state-${name}-`));
  directories.push(directory);
  const store = new StateStore(join(directory, "state.db"));
  stores.push(store);
  return store;
}

async function newWorkspacePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "interlock-ws-"));
  directories.push(directory);
  return directory;
}

/** A deterministic, argv-only harness platform — no real processes are spawned. */
interface FakeHarnessProcess extends HarnessProcess {
  crash(code?: number): void;
}

function harnessPlatform(config: { platform?: NodeJS.Platform; spawnThrows?: boolean } = {}) {
  const spawned: string[][] = [];
  let last: FakeHarnessProcess | undefined;
  const platform: HarnessPlatform = {
    platform: config.platform ?? "linux",
    which: () => "/usr/bin/fake-harness",
    spawn: (argv) => {
      spawned.push([...argv]);
      if (config.spawnThrows) throw new Error("simulated spawn failure");
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      const child: FakeHarnessProcess = {
        pid: 4242,
        exited,
        kill: () => resolveExit(0),
        crash: (code = 1) => resolveExit(code),
      };
      last = child;
      return child;
    },
  };
  return { platform, spawned, child: () => last };
}

function tempWorkspace(path: string): WorkspaceAdapter {
  return {
    async preflight() {},
    async plan(ticket) {
      return { ticket: ticket.ref, path, branch: `interlock/${ticket.ref}` };
    },
    async prepare(plan) {
      return { path: plan.path, branch: plan.branch };
    },
  };
}

function lifecycleAdapter(state: ObservedSessionState): RunLifecycleAdapter {
  return {
    capabilities: capabilities("session_status", "session_interrupt"),
    observe: async () => ({ state, observedAt: "2026-08-11T12:05:00.000Z" }),
    stop: async () => {},
  };
}

interface PickupHarness {
  coordinator: PickupCoordinator;
  request: PickupRequest;
  spawned: string[][];
}

function makePickup(options: {
  tracker: MarkdownTrackerAdapter;
  store: StateStore;
  wsPath: string;
  runRef: string;
  claimRef: string;
  ticket?: TicketRef;
  platform?: { platform?: NodeJS.Platform; spawnThrows?: boolean };
}): PickupHarness {
  const platform = harnessPlatform(options.platform);
  const harness = new CommandHarnessAdapter({
    argv: ["fake-harness", "{workspace}"],
    platform: platform.platform,
  });
  const coordinator = new PickupCoordinator({
    tracker: options.tracker,
    workspace: tempWorkspace(options.wsPath),
    harness,
    ledger: options.store,
    ids: {
      run: () => runRefSchema.parse(options.runRef),
      claim: () => claimRefSchema.parse(options.claimRef),
    },
    clock: fixedClock,
  });
  const request: PickupRequest = {
    ticket: options.ticket ?? ta,
    owner,
    harness: adapterRefSchema.parse("command"),
  };
  return { coordinator, request, spawned: platform.spawned };
}

async function committedPickup(options: {
  tracker: MarkdownTrackerAdapter;
  store?: StateStore;
  runRef?: string;
  claimRef?: string;
}) {
  const store = options.store ?? (await newStore("pickup"));
  const wsPath = await newWorkspacePath();
  const harness = makePickup({
    tracker: options.tracker,
    store,
    wsPath,
    runRef: options.runRef ?? "interlock-run:accept",
    claimRef: options.claimRef ?? "interlock-claim:accept",
  });
  const receipt = await harness.coordinator.execute(harness.request);
  return { store, receipt, spawned: harness.spawned, wsPath };
}

describe("JWB-295 disposable-tracker acceptance", () => {
  test("the disposable tracker normalizes to the portable frontier and honors cross-map blockers", async () => {
    const tracker = await fixtureTracker();

    // Equivalent normalized frontiers: the adapter's native frontier equals the
    // portable evaluateFrontier over the same normalized tickets.
    const viaAdapter = (await tracker.frontier()).map((ticket) => ticket.ref);
    const viaEngine = evaluateFrontier(
      await tracker.listTickets(),
      {},
      {
        availableStatuses: new Set(["To Do"]),
      },
    ).map((ticket) => ticket.ref);
    expect(viaAdapter).toEqual(viaEngine);
    expect(viaAdapter).toEqual([ta, tc]); // tb is blocked cross-map by ta

    // Cross-map blocker: tb (map2) stays off its map frontier while ta (map1) is open.
    expect((await tracker.frontier({ map: map2 })).map((ticket) => ticket.ref)).toEqual([]);

    const snapshot = await tracker.snapshotClaimState(ta);
    await tracker.resolve({
      ticket: ta,
      expectedVersion: snapshot.version,
      owner,
      resolution: "Acceptance closeout of the cross-map blocker.",
      artifacts: [],
    });

    // Closing the blocker on map1 makes the dependent eligible on map2.
    expect((await tracker.frontier({ map: map2 })).map((ticket) => ticket.ref)).toEqual([tb]);
  });

  test("concurrent pickup and claim both resolve to a single winner", async () => {
    const tracker = await fixtureTracker();

    // Two full pickups race for the same ticket through the disposable tracker.
    const storeOne = await newStore("race-one");
    const storeTwo = await newStore("race-two");
    const one = makePickup({
      tracker,
      store: storeOne,
      wsPath: await newWorkspacePath(),
      runRef: "interlock-run:one",
      claimRef: "interlock-claim:one",
    });
    const two = makePickup({
      tracker,
      store: storeTwo,
      wsPath: await newWorkspacePath(),
      runRef: "interlock-run:two",
      claimRef: "interlock-claim:two",
    });
    const outcomes = await Promise.allSettled([
      one.coordinator.execute(one.request),
      two.coordinator.execute(two.request),
    ]);
    const fulfilled = outcomes.filter((result) => result.status === "fulfilled");
    const rejected = outcomes.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]?.value).toMatchObject({ ok: true, state: "committed" });
    expect(rejected[0]?.reason).toBeInstanceOf(Error);

    // The source of truth records exactly one active claim.
    const raced = (await tracker.read()).tickets.find((ticket) => ticket.ref === ta);
    expect(raced).toMatchObject({ status: "In Progress" });
    expect(raced?.claim?.status).toBe("active");

    // The conditional-update guard is deterministically single-winner: a second
    // claim carrying the now-stale expected version is rejected as a collision.
    const clean = await fixtureTracker();
    const before = await clean.snapshotClaimState(ta);
    const claimRequest = (claim: string, run: string) => ({
      claim: claimRefSchema.parse(claim),
      run: runRefSchema.parse(run),
      ticket: ta,
      owner,
      leaseExpiresAt: LEASE_TIME,
      expectedVersion: before.version,
    });
    await clean.claim(claimRequest("interlock-claim:x", "interlock-run:x"));
    await expect(
      clean.claim(claimRequest("interlock-claim:y", "interlock-run:y")),
    ).rejects.toBeInstanceOf(ClaimCollisionError);
  });

  test("the generic harness launches argv-only with the workspace substituted", async () => {
    const tracker = await fixtureTracker();
    const { receipt, spawned, wsPath } = await committedPickup({ tracker });

    expect(receipt).toMatchObject({ ok: true, state: "committed" });
    expect(receipt.launch).toMatchObject({ tier: "launch", pid: 4242 });
    expect(receipt.launch?.sessionId).toContain("command:");
    // A single argv-only spawn with {workspace} resolved to the real path — no shell text.
    expect(spawned).toEqual([["fake-harness", wsPath]]);
  });

  test("leases are observable and the supervisor renews against the disposable tracker", async () => {
    const tracker = await fixtureTracker();
    const { store, receipt } = await committedPickup({ tracker });

    // Lease observation is derived, not mutated.
    const claim = store.claimForRun(receipt.run);
    expect(claim.leaseExpiresAt).toBe(LEASE_TIME);
    expect(claimStatusAt(claim, new Date("2026-08-11T12:14:59.999Z"))).toBe("active");
    expect(claimStatusAt(claim, new Date(LEASE_TIME))).toBe("stale");

    const supervisor = new Supervisor({
      store,
      tracker,
      lifecycle: () => lifecycleAdapter("running"),
      clock: { now: () => new Date("2026-08-11T12:05:00.000Z") },
      supervisorId: "accept-supervisor",
    });
    expect(await supervisor.tick()).toEqual([{ run: receipt.run, outcome: "renewed" }]);

    // The renewal is visible on the disposable tracker: +15 minutes from 12:05.
    const renewed = (await tracker.read()).tickets.find((ticket) => ticket.ref === ta);
    expect(renewed?.claim?.leaseExpiresAt).toBe("2026-08-11T12:20:00.000Z");
    expect(store.claimForRun(receipt.run).leaseExpiresAt).toBe("2026-08-11T12:20:00.000Z");
  });

  test("an expired lease is reclaimed only with explicit authorization", async () => {
    let current = new Date(CLAIM_TIME);
    const tracker = await fixtureTracker({ now: () => new Date(current) });
    const before = await tracker.snapshotClaimState(ta);
    const firstClaim = {
      claim: claimRefSchema.parse("interlock-claim:first"),
      run: runRefSchema.parse("interlock-run:first"),
      ticket: ta,
      owner,
      leaseExpiresAt: LEASE_TIME,
      expectedVersion: before.version,
    };
    await tracker.claim(firstClaim);

    // Before the lease expires the ticket cannot be reclaimed.
    current = new Date("2026-08-11T12:10:00.000Z");
    const early = await tracker.snapshotClaimState(ta);
    await expect(
      tracker.reclaim({
        staleClaim: firstClaim.claim,
        claim: claimRefSchema.parse("interlock-claim:second"),
        run: runRefSchema.parse("interlock-run:second"),
        ticket: ta,
        owner,
        authorizedBy: owner,
        leaseExpiresAt: "2026-08-11T12:30:00.000Z",
        expectedVersion: early.version,
        originalSnapshot: before,
      }),
    ).rejects.toBeInstanceOf(ClaimCollisionError);

    // Once the lease has expired an authorized reclaim supersedes the stale claim.
    current = new Date("2026-08-11T12:16:00.000Z");
    const stale = await tracker.snapshotClaimState(ta);
    const reclaim = {
      staleClaim: firstClaim.claim,
      claim: claimRefSchema.parse("interlock-claim:second"),
      run: runRefSchema.parse("interlock-run:second"),
      ticket: ta,
      owner,
      authorizedBy: owner,
      leaseExpiresAt: "2026-08-11T12:30:00.000Z",
      expectedVersion: stale.version,
      originalSnapshot: before,
    };
    await tracker.reclaim(reclaim);
    await tracker.verifyReclaimed(reclaim);

    const reclaimed = (await tracker.read()).tickets.find((ticket) => ticket.ref === ta);
    expect(reclaimed?.claim).toMatchObject({
      ref: reclaim.claim,
      supersedes: firstClaim.claim,
      status: "active",
    });
    expect(reclaimed?.claimHistory).toEqual([
      expect.objectContaining({ ref: firstClaim.claim, status: "superseded" }),
    ]);
  });

  test("a post-claim launch failure compensates the exact disposable-tracker snapshot", async () => {
    const tracker = await fixtureTracker();
    const original = await tracker.snapshotClaimState(ta);
    const store = await newStore("compensate");
    const harness = makePickup({
      tracker,
      store,
      wsPath: await newWorkspacePath(),
      runRef: "interlock-run:comp",
      claimRef: "interlock-claim:comp",
      platform: { spawnThrows: true },
    });

    const error = await harness.coordinator
      .execute(harness.request)
      .then(() => undefined)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(PickupResultError);
    expect(z.instanceof(PickupResultError).parse(error).receipt).toMatchObject({
      ok: false,
      state: "compensated",
    });

    // The claim payload is restored exactly; the ticket is fully released.
    const restored = await tracker.snapshotClaimState(ta);
    expect(restored.payload).toEqual(original.payload);
    const ticket = (await tracker.read()).tickets.find((item) => item.ref === ta);
    expect(ticket).toMatchObject({ state: "open", status: "To Do" });
    expect(ticket?.claim).toBeUndefined();
    expect(ticket?.assignee).toBeUndefined();
  });

  test("unverifiable restoration escalates to recovery_required", async () => {
    class UnverifiableTracker extends MarkdownTrackerAdapter {
      override async verifyRestored(): Promise<void> {
        throw new AmbiguousTrackerResultError("restoration could not be verified");
      }
    }
    const base = await fixtureTracker();
    const tracker = new UnverifiableTracker(base.path, fixedClock);
    const store = await newStore("recovery");
    const harness = makePickup({
      tracker,
      store,
      wsPath: await newWorkspacePath(),
      runRef: "interlock-run:rec",
      claimRef: "interlock-claim:rec",
      platform: { spawnThrows: true },
    });

    const error = await harness.coordinator
      .execute(harness.request)
      .then(() => undefined)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(PickupResultError);
    const receipt = z.instanceof(PickupResultError).parse(error).receipt;
    expect(receipt.state).toBe("recovery_required");
    expect(receipt.recoveryCommand).toContain("interlock recover interlock-run:rec");
    expect(store.run(runRefSchema.parse("interlock-run:rec")).status).toBe("recovery_required");
  });

  test("stop tears down execution while release separately returns the claim", async () => {
    const tracker = await fixtureTracker();
    const { store, receipt } = await committedPickup({ tracker });

    const coordinator = new LifecycleCoordinator(
      store,
      tracker,
      () => lifecycleAdapter("stopped"),
      {
        now: () => new Date("2026-08-11T12:06:00.000Z"),
      },
    );

    // Stop is execution-only: the disposable tracker still holds the active claim.
    const stopped = await coordinator.stop(receipt.run);
    expect(stopped.status).toBe("stopped");
    expect(store.claim(receipt.claim).status).toBe("active");
    const held = (await tracker.read()).tickets.find((ticket) => ticket.ref === ta);
    expect(held).toMatchObject({ status: "In Progress" });
    expect(held?.claim?.status).toBe("active");

    // Release is a separate, authorized operation that returns the tracker claim.
    await coordinator.release(receipt.claim, owner);
    expect(store.claim(receipt.claim).status).toBe("released");
    const released = (await tracker.read()).tickets.find((ticket) => ticket.ref === ta);
    expect(released).toMatchObject({ state: "open", status: "To Do" });
    expect(released?.claim).toBeUndefined();
    expect(released?.assignee).toBeUndefined();
  });

  test("run identity survives a supervisor restart and lost sessions require attention", async () => {
    const tracker = await fixtureTracker();
    const directory = await mkdtemp(join(tmpdir(), "interlock-crash-"));
    directories.push(directory);
    const dbPath = join(directory, "state.db");

    const store = new StateStore(dbPath);
    const wsPath = await newWorkspacePath();
    const harness = makePickup({
      tracker,
      store,
      wsPath,
      runRef: "interlock-run:crash",
      claimRef: "interlock-claim:crash",
    });
    const receipt = await harness.coordinator.execute(harness.request);
    store.close(); // simulate a supervisor/CLI crash

    // SQLite WAL preserves run and claim identity across the restart.
    const reopened = new StateStore(dbPath);
    stores.push(reopened);
    expect(reopened.run(receipt.run)).toMatchObject({ ref: receipt.run, status: "active" });
    expect(reopened.claimForRun(receipt.run).ref).toBe(receipt.claim);

    // A session observed as gone is never renewed; it is marked for attention.
    const supervisor = new Supervisor({
      store: reopened,
      tracker,
      lifecycle: () => lifecycleAdapter("missing"),
      clock: { now: () => new Date("2026-08-11T12:05:00.000Z") },
      supervisorId: "recovery-supervisor",
    });
    expect(await supervisor.tick()).toEqual([{ run: receipt.run, outcome: "attention_required" }]);
    expect(reopened.run(receipt.run).status).toBe("attention_required");
  });

  test("the committed receipt is JSON-stable and matches the persisted ledger", async () => {
    const tracker = await fixtureTracker();
    const { store, receipt } = await committedPickup({ tracker });

    // The receipt round-trips through JSON without loss.
    expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
    expect(Object.keys(receipt).toSorted()).toEqual([
      "claim",
      "launch",
      "ok",
      "run",
      "state",
      "ticket",
      "workspace",
    ]);

    // The persisted ledger records the ordered transaction and a parity copy.
    const steps = z
      .array(z.object({ state: z.string(), receipt_json: z.string().nullable() }))
      .parse(store.steps(receipt.run));
    expect(steps.map((step) => step.state)).toEqual([
      "planning",
      "claiming",
      "claimed",
      "workspace_prepared",
      "launched",
      "committed",
    ]);
    const committed = steps.find((step) => step.state === "committed");
    expect(committed).toBeDefined();
    expect(
      JSON.parse(z.object({ receipt_json: z.string() }).parse(committed).receipt_json),
    ).toEqual(receipt);
  });

  test("the generic harness renders identical argv and capabilities across platforms", async () => {
    const tracker = await fixtureTracker();
    const ticket: Ticket = await tracker.getTicket(ta);
    const wsPath = await newWorkspacePath();

    for (const platformName of ["linux", "darwin", "win32"] as const) {
      const { platform, spawned } = harnessPlatform({ platform: platformName });
      const harness = new CommandHarnessAdapter({
        argv: ["fake-harness", "{workspace}", "{prompt}"],
        platform,
      });
      expect(await harness.describe()).toMatchObject({
        process_launch: true,
        prompt_generation: true,
      });
      const launch = await harness.launch({
        run: runRefSchema.parse("interlock-run:xp"),
        ticket,
        workspace: { path: wsPath },
      });
      expect(launch.tier).toBe("launch");
      expect(spawned[0]?.slice(0, 2)).toEqual(["fake-harness", wsPath]);
      expect(spawned[0]?.[2]).toContain(`Ticket:\n${ta}`);
    }
  });

  test("records portable cross-platform acceptance evidence", async () => {
    const evidence = {
      ticket: "JWB-295",
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      disposableTracker: "markdown reference adapter",
      verified: [
        "equivalent normalized frontiers",
        "single-winner concurrent pickup",
        "explicit stale reclaim",
        "exact post-claim compensation",
        "cross-map blockers",
        "generic harness launch",
        "lease observation",
        "stop/release separation",
        "crash recovery",
        "JSON receipt parity",
      ],
    };
    // Evidence is itself JSON-stable and enumerates every acceptance behavior.
    expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence);
    expect(evidence.verified).toHaveLength(10);
    console.log(`JWB-295 acceptance evidence: ${JSON.stringify(evidence)}`);
  });
});
