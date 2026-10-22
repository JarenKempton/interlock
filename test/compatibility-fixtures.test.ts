import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
  type HarnessAdapter,
  type LaunchReceipt,
  type Ledger,
  type ReclaimRequest,
  type ReleaseClaimRequest,
  type RenewLeaseRequest,
  type RestoreClaimRequest,
  type TrackerAdapter,
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
  type Claim,
  capabilities,
  type Run,
  type RunRef,
  type Ticket,
  type TicketRef,
  type TrackerSnapshot,
} from "../src/domain/model.ts";
import { PickupCoordinator, PickupResultError } from "../src/execution/pickup.ts";
import { evaluateFrontier } from "../src/frontier/evaluate.ts";

const fixtureRoot = join(import.meta.dir, "fixtures", "compatibility");

const legacyWfFixtureSchema = z.object({
  formatVersion: z.number(),
  commands: z.array(
    z.object({
      argv: z.array(z.string()),
      expectedParse: z.object({
        operation: z.union([z.literal("frontier"), z.literal("pickup")]),
        reference: z.string(),
        frontier: z.boolean(),
        harnessLaunch: z.boolean(),
        resumeOnly: z.boolean(),
        dryRun: z.boolean(),
        json: z.boolean(),
      }),
    }),
  ),
  offlineGolden: z.object({
    map: z.object({ key: z.string(), title: z.string() }),
    tickets: z.array(
      z.object({
        key: z.string(),
        title: z.string(),
        role: z.union([
          z.literal("task"),
          z.literal("research"),
          z.literal("prototype"),
          z.literal("decision"),
        ]),
        status: z.string(),
        order: z.number(),
      }),
    ),
    frontierReceipt: z.object({
      ok: z.boolean(),
      action: z.string(),
      map: z.object({ key: z.string(), title: z.string() }),
      tickets: z.array(
        z.object({
          key: z.string(),
          title: z.string(),
          role: z.union([
            z.literal("task"),
            z.literal("research"),
            z.literal("prototype"),
            z.literal("decision"),
          ]),
          status: z.string(),
        }),
      ),
    }),
    pickupPlanReceipt: z.object({
      ok: z.boolean(),
      action: z.string(),
      state: z.string(),
      transactionId: z.string(),
      ticket: z.object({
        key: z.string(),
        title: z.string(),
        role: z.union([
          z.literal("task"),
          z.literal("research"),
          z.literal("prototype"),
          z.literal("decision"),
        ]),
      }),
      map: z.object({ key: z.string(), title: z.string() }),
      repository: z.object({
        github: z.string(),
        baseBranch: z.string(),
        baseCommit: z.string(),
      }),
      workspace: z.object({ path: z.string(), branch: z.string(), policy: z.string() }),
      claim: z.null(),
      t3: z.object({ threadId: z.null(), title: z.string(), worktreePath: z.string() }),
    }),
    frontierPickupSelects: z.string(),
  }),
  liveFrontierCapture: z.object({
    capturedAt: z.string(),
    argv: z.array(z.string()),
    result: z.object({
      ok: z.boolean(),
      code: z.string(),
      message: z.string(),
      transactionId: z.null(),
      stage: z.string(),
      recoverable: z.boolean(),
      details: z.object({ map: z.string() }),
    }),
  }),
});

const pickupFixtureSchema = z.object({
  ticket: z.object({
    ref: z.string(),
    map: z.string(),
    kind: z.union([
      z.literal("task"),
      z.literal("research"),
      z.literal("prototype"),
      z.literal("decision"),
    ]),
    state: z.enum(["open", "closed"]),
    status: z.string(),
    assignee: z.string().optional(),
    order: z.number(),
    blockedBy: z.string().optional(),
  }),
  request: z.object({ owner: z.string(), harness: z.string() }),
  snapshot: z.object({ version: z.string(), payload: z.unknown() }),
  workspacePlan: z.object({ path: z.string(), branch: z.string() }),
  clock: z.string(),
  expected: z.object({
    state: z.union([
      z.literal("planning"),
      z.literal("claiming"),
      z.literal("claimed"),
      z.literal("workspace_prepared"),
      z.literal("launched"),
      z.literal("committed"),
      z.literal("compensating"),
      z.literal("compensated"),
      z.literal("collision"),
      z.literal("recovery_required"),
    ]),
    humanOwner: z.string(),
    expectedVersion: z.string(),
    leaseExpiresAt: z.string(),
    workspace: z.object({ path: z.string(), branch: z.string() }),
    steps: z.array(z.string()),
  }),
});

const frontierFixtureSchema = z.object({
  scope: z.string(),
  availableStatuses: z.array(z.string()),
  tickets: z.array(
    z.object({
      ref: z.string(),
      map: z.string(),
      kind: z.union([
        z.literal("task"),
        z.literal("research"),
        z.literal("prototype"),
        z.literal("decision"),
      ]),
      state: z.enum(["open", "closed"]),
      status: z.string(),
      assignee: z.string().optional(),
      order: z.number(),
      blockedBy: z.string().optional(),
    }),
  ),
  expectedRefs: z.array(z.string()),
});

const errorsFixtureSchema = z.object({
  cases: z.array(
    z.object({
      name: z.string(),
      failure: z.object({
        phase: z.union([
          z.literal("claim"),
          z.literal("workspace_prepare"),
          z.literal("harness_launch"),
        ]),
        error: z.union([
          z.literal("claim_collision"),
          z.literal("ambiguous_tracker_result"),
          z.literal("error"),
        ]),
        restorationError: z.literal("ambiguous_tracker_result").optional(),
      }),
      expected: z.object({
        state: z.union([
          z.literal("planning"),
          z.literal("claiming"),
          z.literal("claimed"),
          z.literal("workspace_prepared"),
          z.literal("launched"),
          z.literal("committed"),
          z.literal("compensating"),
          z.literal("compensated"),
          z.literal("collision"),
          z.literal("recovery_required"),
        ]),
        restoreCalls: z.number(),
        restoresOriginalSnapshot: z.boolean().optional(),
        workspacePrepareCalls: z.number().optional(),
        harnessLaunchCalls: z.number().optional(),
        recoveryRequiredSaves: z.number(),
      }),
    }),
  ),
});

function fixture<T>(name: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")));
}

type TicketFixture = z.infer<typeof pickupFixtureSchema.shape.ticket>;

function ticketFromFixture(value: TicketFixture): Ticket {
  const ref = ticketRefSchema.parse(value.ref);
  return {
    ref,
    map: mapRefSchema.parse(value.map),
    kind: value.kind,
    state: value.state,
    status: value.status,
    ...(value.assignee ? { assignee: actorRefSchema.parse(value.assignee) } : {}),
    ...(value.blockedBy
      ? {
          dependencies: [
            {
              blocking: ticketRefSchema.parse(value.blockedBy),
              blocked: ref,
              kind: "blocks" as const,
            },
          ],
        }
      : {}),
    order: value.order,
  };
}

type PickupFixture = z.infer<typeof pickupFixtureSchema>;

type LegacyParse = z.infer<typeof legacyWfFixtureSchema.shape.commands.element.shape.expectedParse>;

function parseLegacyFlags(argv: string[]): LegacyParse {
  const [operation, reference, ...flags] = argv;
  if ((operation !== "frontier" && operation !== "pickup") || !reference) {
    throw new Error("Legacy command requires frontier or pickup plus one reference");
  }
  const known = new Set(["--frontier", "--t3", "--resume", "--dry-run", "--json"]);
  const unknown = flags.filter((flag) => !known.has(flag));
  if (unknown.length > 0) throw new Error(`Unknown legacy flags: ${unknown.join(", ")}`);
  if (operation === "frontier" && flags.some((flag) => flag !== "--json")) {
    throw new Error("Legacy frontier accepts only --json");
  }
  return {
    operation,
    reference,
    frontier: flags.includes("--frontier"),
    harnessLaunch: flags.includes("--t3"),
    resumeOnly: flags.includes("--resume"),
    dryRun: flags.includes("--dry-run"),
    json: flags.includes("--json"),
  };
}

class FixtureLedger implements Ledger {
  readonly steps: string[] = [];
  readonly runs: Run[] = [];
  readonly claims: Claim[] = [];
  readonly recoveryRequired: Array<{
    run: Run;
    receipt: unknown;
    error: unknown;
    evidence: unknown;
  }> = [];

  saveRun(run: Run): void {
    this.runs.push(structuredClone(run));
  }

  saveClaim(claim: Claim): void {
    this.claims.push(structuredClone(claim));
  }

  commitClaim(claim: Claim, receipt: unknown): void {
    this.saveClaim(claim);
    this.recordStep(claim.run, "claimed", receipt);
  }

  commitRun(run: Run, state: string, receipt: unknown): void {
    this.saveRun(run);
    this.recordStep(run.ref, state, receipt);
  }

  recordStep(_run: RunRef, state: string, _receipt?: unknown, _error?: unknown): void {
    this.steps.push(state);
  }

  saveRecoveryRequired(run: Run, receipt: unknown, error: unknown, evidence: unknown): void {
    this.saveRun(run);
    this.recoveryRequired.push({ run: structuredClone(run), receipt, error, evidence });
    this.recordStep(run.ref, "recovery_required", receipt, error);
  }
}

class FixtureTracker implements TrackerAdapter {
  claimError?: Error;
  verifyRestoreError?: Error;
  claimRequest?: ClaimRequest;
  restoreRequest?: RestoreClaimRequest;
  restoreCalls = 0;

  constructor(
    readonly ticket: Ticket,
    readonly snapshot: TrackerSnapshot,
  ) {}

  async describe() {
    return capabilities(
      "atomic_assignment",
      "conditional_update",
      "claim_comments",
      "claim_identity",
      "lease_metadata",
    );
  }
  async preflight(_ticket: TicketRef) {}
  async getTicket(_ticket: TicketRef): Promise<Ticket> {
    return this.ticket;
  }
  async snapshotClaimState(_ticket: TicketRef): Promise<TrackerSnapshot> {
    return this.snapshot;
  }
  async claim(request: ClaimRequest) {
    this.claimRequest = request;
    if (this.claimError) throw this.claimError;
  }
  async verifyClaim(_request: ClaimRequest) {}
  async restoreClaimState(request: RestoreClaimRequest) {
    this.restoreCalls += 1;
    this.restoreRequest = request;
  }
  async verifyRestored(_request: RestoreClaimRequest) {
    if (this.verifyRestoreError) throw this.verifyRestoreError;
  }
  async renewLease(_request: RenewLeaseRequest) {}
  async verifyLease(_request: RenewLeaseRequest) {}
  async releaseClaim(_request: ReleaseClaimRequest) {}
  async verifyReleased(_request: ReleaseClaimRequest) {}
  async reclaim(_request: ReclaimRequest) {}
  async verifyReclaimed(_request: ReclaimRequest) {}
}

class FixtureWorkspace implements WorkspaceAdapter {
  prepareError?: Error;
  prepareCalls = 0;
  preflightTicket?: Ticket;

  constructor(readonly planResult: { ticket: TicketRef; path: string; branch: string }) {}

  async preflight(ticket: Ticket) {
    this.preflightTicket = ticket;
  }
  async plan(_ticket: Ticket) {
    return this.planResult;
  }
  async prepare(plan: { ticket: TicketRef; path: string; branch: string }) {
    this.prepareCalls += 1;
    if (this.prepareError) throw this.prepareError;
    return { path: plan.path, branch: plan.branch };
  }
}

class FixtureHarness implements HarnessAdapter {
  launchError?: Error;
  launchCalls = 0;

  async describe() {
    return capabilities("process_launch");
  }
  async preflight() {}
  async launch(): Promise<LaunchReceipt> {
    this.launchCalls += 1;
    if (this.launchError) throw this.launchError;
    return { sessionId: "fixture-session", tier: "launch" };
  }
  async stop() {}
}

function pickupSubject(value: PickupFixture) {
  const ticket = ticketFromFixture(value.ticket);
  const tracker = new FixtureTracker(ticket, value.snapshot);
  const workspace = new FixtureWorkspace({
    ticket: ticket.ref,
    path: value.workspacePlan.path,
    branch: value.workspacePlan.branch,
  });
  const harness = new FixtureHarness();
  const ledger = new FixtureLedger();
  const coordinator = new PickupCoordinator({
    tracker,
    workspace,
    harness,
    ledger,
    ids: {
      run: () => runRefSchema.parse("interlock-run:fixture"),
      claim: () => claimRefSchema.parse("interlock-claim:fixture"),
    },
    clock: { now: () => new Date(value.clock) },
  });
  const request = {
    ticket: ticket.ref,
    owner: actorRefSchema.parse(value.request.owner),
    harness: adapterRefSchema.parse(value.request.harness),
  };
  return { coordinator, tracker, workspace, harness, ledger, request };
}

async function pickupFailure(
  subject: ReturnType<typeof pickupSubject>,
): Promise<PickupResultError> {
  try {
    await subject.coordinator.execute(subject.request);
    throw new Error("Expected pickup fixture to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PickupResultError);
    return z.instanceof(PickupResultError).parse(error);
  }
}

describe("compatibility fixtures exercise production behavior", () => {
  test("legacy command forms, receipts, and TypeScript frontier parity stay golden", () => {
    const value = fixture("legacy-wf.json", legacyWfFixtureSchema);

    expect(value.formatVersion).toBe(1);
    for (const command of value.commands) {
      expect(parseLegacyFlags(command.argv)).toEqual(command.expectedParse);
    }

    expect(Object.keys(value.offlineGolden.frontierReceipt).sort()).toEqual([
      "action",
      "map",
      "ok",
      "tickets",
    ]);
    expect(Object.keys(value.offlineGolden.pickupPlanReceipt).sort()).toEqual([
      "action",
      "claim",
      "map",
      "ok",
      "repository",
      "state",
      "t3",
      "ticket",
      "transactionId",
      "workspace",
    ]);

    const mapRef = mapRefSchema.parse(
      `tracker:fixture:workspace:map:${value.offlineGolden.map.key}`,
    );
    const portableTickets = value.offlineGolden.tickets.map<Ticket>((ticket) => ({
      ref: ticketRefSchema.parse(`tracker:fixture:workspace:ticket:${ticket.key}`),
      map: mapRef,
      kind: ticket.role,
      state: "open",
      status: ticket.status,
      order: ticket.order,
    }));
    const portableFrontier = evaluateFrontier(
      portableTickets,
      { map: mapRef },
      {
        availableStatuses: new Set(["To Do"]),
      },
    );
    const nativeIds = portableFrontier.map((ticket) => ticket.ref.split(":").at(-1));
    expect(nativeIds).toEqual(
      value.offlineGolden.frontierReceipt.tickets.map((ticket) => ticket.key),
    );
    expect(value.offlineGolden.frontierReceipt).toMatchObject({
      ok: true,
      action: "frontier_listed",
      map: value.offlineGolden.map,
      tickets: value.offlineGolden.tickets.map(({ order: _order, ...ticket }) => ticket),
    });
    expect(nativeIds.length).toBeGreaterThan(0);
    expect(value.offlineGolden.frontierPickupSelects).toBe(z.string().parse(nativeIds[0]));

    const pickup = fixture("pickup.json", pickupFixtureSchema);
    expect(value.offlineGolden.pickupPlanReceipt.workspace).toEqual({
      ...pickup.workspacePlan,
      policy: "ticket-key-v1",
    });
    expect(value.offlineGolden.pickupPlanReceipt.ticket).toMatchObject({
      key: pickup.ticket.ref.split(":").at(-1),
      role: pickup.ticket.kind,
    });
    expect(value.offlineGolden.pickupPlanReceipt.t3).toMatchObject({
      threadId: null,
      worktreePath: pickup.workspacePlan.path,
    });

    expect(value.liveFrontierCapture).toEqual({
      capturedAt: "2026-08-11",
      argv: ["frontier", "JWB-232", "--json"],
      result: {
        ok: false,
        code: "map_config_missing",
        message: "No WF map configuration for JWB-232",
        transactionId: null,
        stage: "resolve",
        recoverable: false,
        details: { map: "JWB-232" },
      },
    });
  });

  test("frontier fixture is evaluated and ordered by evaluateFrontier", () => {
    const value = fixture("frontier.json", frontierFixtureSchema);
    const tickets = value.tickets.map(ticketFromFixture);

    const result = evaluateFrontier(
      tickets,
      { map: mapRefSchema.parse(value.scope) },
      {
        availableStatuses: new Set(value.availableStatuses),
      },
    );

    expect(result.map((ticket) => String(ticket.ref))).toEqual(value.expectedRefs);
  });

  test("pickup fixture drives PickupCoordinator and asserts every expected field", async () => {
    const value = fixture("pickup.json", pickupFixtureSchema);
    const subject = pickupSubject(value);

    const result = await subject.coordinator.execute(subject.request);

    expect(result.state).toBe(value.expected.state);
    expect(result.workspace).toEqual(value.expected.workspace);
    expect(subject.tracker.claimRequest).toMatchObject({
      owner: value.expected.humanOwner,
      expectedVersion: value.expected.expectedVersion,
      leaseExpiresAt: value.expected.leaseExpiresAt,
    });
    expect(subject.workspace.preflightTicket).toEqual(ticketFromFixture(value.ticket));
    expect(subject.workspace.planResult).toEqual({
      ticket: ticketRefSchema.parse(value.ticket.ref),
      path: value.workspacePlan.path,
      branch: value.workspacePlan.branch,
    });
    expect(subject.ledger.steps).toEqual(value.expected.steps);
    expect(subject.ledger.claims.at(-1)).toMatchObject({
      ticket: value.ticket.ref,
      humanOwner: value.expected.humanOwner,
      previousState: value.snapshot,
      leaseExpiresAt: value.expected.leaseExpiresAt,
      status: "active",
      currentVersion: value.expected.expectedVersion,
    });
    expect(subject.ledger.runs.at(-1)).toMatchObject({
      ticket: value.ticket.ref,
      harness: value.request.harness,
      workspace: value.expected.workspace,
      status: "active",
    });
  });

  test("failure fixtures drive coordinator compensation paths", async () => {
    const pickup = fixture("pickup.json", pickupFixtureSchema);
    const value = fixture("errors.json", errorsFixtureSchema);

    for (const scenario of value.cases) {
      const subject = pickupSubject(pickup);
      const error =
        scenario.failure.error === "claim_collision"
          ? new ClaimCollisionError()
          : scenario.failure.error === "ambiguous_tracker_result"
            ? new AmbiguousTrackerResultError()
            : new Error(`${scenario.failure.phase} failed`);
      if (scenario.failure.phase === "claim") subject.tracker.claimError = error;
      if (scenario.failure.phase === "workspace_prepare") subject.workspace.prepareError = error;
      if (scenario.failure.phase === "harness_launch") subject.harness.launchError = error;
      if (scenario.failure.restorationError === "ambiguous_tracker_result") {
        subject.tracker.verifyRestoreError = new AmbiguousTrackerResultError();
      }

      const result = await pickupFailure(subject);

      expect(result.receipt.state, scenario.name).toBe(scenario.expected.state);
      expect(subject.tracker.restoreCalls, scenario.name).toBe(scenario.expected.restoreCalls);
      expect(subject.ledger.recoveryRequired.length, scenario.name).toBe(
        scenario.expected.recoveryRequiredSaves,
      );
      if (scenario.expected.restoresOriginalSnapshot !== undefined) {
        expect(
          subject.tracker.restoreRequest?.originalSnapshot === pickup.snapshot,
          scenario.name,
        ).toBe(scenario.expected.restoresOriginalSnapshot);
      }
      if (scenario.expected.workspacePrepareCalls !== undefined) {
        expect(subject.workspace.prepareCalls, scenario.name).toBe(
          scenario.expected.workspacePrepareCalls,
        );
      }
      if (scenario.expected.harnessLaunchCalls !== undefined) {
        expect(subject.harness.launchCalls, scenario.name).toBe(
          scenario.expected.harnessLaunchCalls,
        );
      }
    }
  });
});
