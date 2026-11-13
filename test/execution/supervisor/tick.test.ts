import { expect, test } from "bun:test";
import type { GateEvidence } from "../../../src/domain/gate/evidence.ts";
import type { HostSessionView, HostSteerResult } from "../../../src/domain/host/capability.ts";
import {
  actorRefSchema,
  adapterRefSchema,
  claimRefSchema,
  laneRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../../../src/domain/refs/identifiers.ts";
import type {
  Lane,
  LaneRefusalCode,
  LaneResult,
  LaneState,
} from "../../../src/domain/lane/lifecycle.ts";
import type { Claim, LaneRef, Ticket, TicketRef } from "../../../src/domain/model.ts";
import type {
  JournalEntry,
  SupervisorPolicy,
  SupervisorPorts,
} from "../../../src/execution/supervisor/ports.ts";
import { superviseTick } from "../../../src/execution/supervisor/tick.ts";

const map = mapRefSchema.parse("jira:x:JWB:map:JWB-1");
const owner = actorRefSchema.parse("owner");
const ref = (key: string) => ticketRefSchema.parse(`jira:x:JWB:ticket:${key}`);
const policy: SupervisorPolicy = {
  projects: [{ map, repository: "/repo" }],
  parallelism: 2,
  stallAfterMs: 30 * 60_000,
  maxResumes: 1,
};

class World implements SupervisorPorts {
  time = new Date("2026-11-10T00:00:00.000Z");
  tickets = new Map<TicketRef, Ticket>();
  lanesById = new Map<LaneRef, Lane>();
  claims = new Map<LaneRef, Claim>();
  remote = new Map<LaneRef, string | undefined>();
  mergedUrls = new Set<string>();
  heldTickets = new Set<TicketRef>();
  views = new Map<LaneRef, HostSessionView>();
  steerResult: HostSteerResult = { state: "delivered" };
  completeRefusal: LaneRefusalCode | undefined;
  launchFailure: string | undefined;
  log: string[] = [];
  journalEntries = new Map<LaneRef, JournalEntry[]>();
  configurationErrors = new Map<LaneRef, string>();

  ticket(key: string, patch: Partial<Ticket> = {}): Ticket {
    const ticket: Ticket = {
      ref: ref(key),
      map,
      kind: "task",
      state: "open",
      status: "To Do",
      order: Number(key.split("-")[1]),
      ...patch,
    };
    this.tickets.set(ticket.ref, ticket);
    return ticket;
  }

  lane(key: string, state: LaneState, patch: Partial<Lane> = {}): Lane {
    const id = laneRefSchema.parse(`interlock-lane:${key}`);
    const lane: Lane = {
      id,
      ticket: ref(key),
      run: runRefSchema.parse(`interlock-run:${key}`),
      claim: claimRefSchema.parse(`interlock-claim:${key}`),
      state,
      artifact: `https://github.com/o/r/pull/${key}`,
      head: "a".repeat(40),
      evidence: [],
      reviewRound: 1,
      maxReviewRounds: 3,
      createdAt: this.time.toISOString(),
      updatedAt: this.time.toISOString(),
      ...patch,
    };
    this.lanesById.set(id, lane);
    if (lane.claim)
      this.claims.set(id, {
        ref: lane.claim,
        ticket: ref(key),
        humanOwner: owner,
        run: runRefSchema.parse(`interlock-run:${key}`),
        previousState: { version: "1", payload: null },
        claimedAt: this.time.toISOString(),
        leaseExpiresAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        claimHomeUrl: "https://github.com/o/r.git",
      });
    this.remote.set(id, lane.claim);
    if (!this.tickets.has(ref(key))) this.ticket(key, { status: "In Progress", assignee: owner });
    return lane;
  }

  journal = {
    entries: (lane: LaneRef) => this.journalEntries.get(lane) ?? [],
    record: (lane: LaneRef, entry: JournalEntry) => {
      this.journalEntries.set(lane, [...(this.journalEntries.get(lane) ?? []), entry]);
    },
  };

  now = () => this.time;

  lanes = () =>
    [...this.lanesById.values()].map((lane) => {
      const claim = this.claims.get(lane.id);
      const configurationError = this.configurationErrors.get(lane.id);
      return {
        lane,
        live: true,
        ...(lane.run ? { run: lane.run } : {}),
        ...(claim ? { claim } : {}),
        claimedStatus: "In Progress",
        ...(configurationError ? { configurationError } : {}),
      };
    });

  read = async (ticket: TicketRef) => {
    const found = this.tickets.get(ticket);
    if (!found) throw new Error(`missing ${ticket}`);
    return found;
  };

  remoteClaim = async ({ lane }: { lane: Lane }) => ({
    claim: this.remote.get(lane.id),
    source: "refs/interlock/claims/x",
  });

  merged = async (url: string) => ({
    merged: this.mergedUrls.has(url),
    url,
    repository: "github.com/o/r",
    branch: "task/x",
    head: "a".repeat(40),
    base: "main",
    commit: this.mergedUrls.has(url) ? "b".repeat(40) : null,
  });

  complete = async (lane: Lane): Promise<LaneResult<Lane>> => {
    this.log.push(`complete ${lane.ticket}`);
    if (this.completeRefusal)
      return { ok: false, refusal: { code: this.completeRefusal, message: "refused" } };
    const done = { ...lane, state: "done" as const };
    this.lanesById.set(lane.id, done);
    if (lane.ticket) {
      const ticket = this.tickets.get(lane.ticket);
      if (ticket) this.tickets.set(lane.ticket, { ...ticket, state: "closed", status: "Done" });
    }
    const receipt: GateEvidence = {
      gate: "claim_released",
      fact: "claim_lock_released",
      source: { system: "git", ref: "refs/interlock/claims/x" },
      observed: { value: "v2" },
      observedAt: this.time.toISOString(),
    };
    return { ok: true, value: done, receipts: [receipt] };
  };

  outsideMap = new Set<TicketRef>();

  frontier = async () => [...this.tickets.values()].filter((t) => !this.outsideMap.has(t.ref));

  eligible = async (_project: unknown, ticket: Ticket) => {
    if (ticket.state !== "open" || ticket.assignee || ticket.status !== "To Do")
      return "unavailable" as const;
    for (const dependency of ticket.dependencies ?? [])
      if (this.tickets.get(dependency.blocking)?.state !== "closed") return "blocked" as const;
    return "eligible" as const;
  };

  held = async (_project: unknown, ticket: Ticket) => this.heldTickets.has(ticket.ref);

  launch = async (_project: unknown, ticket: Ticket) => {
    this.log.push(`launch ${ticket.ref}`);
    if (this.launchFailure) throw new Error(this.launchFailure);
    const key = ticket.ref.split(":").at(-1) ?? "";
    const lane = this.lane(key, "implementing");
    this.view(lane, "running", 1);
    this.tickets.set(ticket.ref, { ...ticket, status: "In Progress", assignee: owner });
    return { lane: lane.id, session: `thread-${key}` };
  };

  sessions = async (lane: Lane) => {
    const view = this.views.get(lane.id);
    return view ? [view] : [];
  };

  steer = async (view: HostSessionView, operation: readonly [LaneRef, string]) => {
    this.log.push(`steer ${view.session.session} ${operation[1]}`);
    return this.steerResult;
  };

  attention = async (lane: Lane, reason: string) => {
    this.log.push(`attention ${lane.ticket} ${reason}`);
    this.lanesById.set(lane.id, {
      ...lane,
      state: "attention",
      previousState: lane.state,
      attentionReason: reason,
    });
  };

  view(lane: Lane, status: string, messages: number): HostSessionView {
    const view: HostSessionView = {
      session: {
        environment: "env",
        host: adapterRefSchema.parse("t3"),
        harness: adapterRefSchema.parse("codex"),
        session: `thread-${lane.id}`,
        lane: lane.id,
        ticket: lane.ticket ?? ref("JWB-0"),
      },
      status,
      messages: Array.from({ length: messages }, (_, index) => ({
        role: "assistant",
        text: `m${index}`,
      })),
    };
    this.views.set(lane.id, view);
    return view;
  }
}

const blockedBy = (key: string) => ({
  dependencies: [{ blocking: ref(key), blocked: ref("JWB-0"), kind: "blocks" as const }],
});

test("a tick completes merged lanes first, then launches newly unblocked tickets up to the limit", async () => {
  const world = new World();
  const merged = world.lane("JWB-2", "approved");
  world.mergedUrls.add(merged.artifact ?? "");
  world.ticket("JWB-3", blockedBy("JWB-2"));
  world.ticket("JWB-4", blockedBy("JWB-2"));
  world.ticket("JWB-5", blockedBy("JWB-2"));
  world.lane("JWB-9", "reviewing");

  const report = await superviseTick(world, policy);

  expect(world.log).toEqual([`complete ${ref("JWB-2")}`, `launch ${ref("JWB-3")}`]);
  expect(report.completed.map((item) => item.ticket)).toEqual([ref("JWB-2")]);
  expect(report.launched.map((item) => item.ticket)).toEqual([ref("JWB-3")]);
  expect(report.evidence).toContainEqual({
    lane: merged.id,
    evidence: {
      gate: "merge",
      fact: "pull_request_merged",
      source: { system: "github", ref: merged.artifact ?? "" },
      observed: { value: "b".repeat(40) },
      observedAt: world.time.toISOString(),
    },
  });
});

test("restarting the supervisor repeats no completion or launch", async () => {
  const world = new World();
  const merged = world.lane("JWB-2", "approved");
  world.mergedUrls.add(merged.artifact ?? "");
  world.ticket("JWB-3", blockedBy("JWB-2"));
  await superviseTick(world, policy);
  const journal = world.journalEntries.get(merged.id)?.length;

  const restarted = await superviseTick(world, policy);

  expect(world.log).toEqual([`complete ${ref("JWB-2")}`, `launch ${ref("JWB-3")}`]);
  expect(restarted.completed).toEqual([]);
  expect(restarted.launched).toEqual([]);
  expect(world.journalEntries.get(merged.id)?.length).toBe(journal);
});

for (const [edit, change] of [
  [
    "reassigned",
    (world: World) =>
      world.ticket("JWB-2", { status: "In Progress", assignee: actorRefSchema.parse("someone") }),
  ],
  ["reopened", (world: World) => world.ticket("JWB-2", { status: "To Do", assignee: owner })],
  [
    "reblocked",
    (world: World) => {
      world.ticket("JWB-7");
      world.ticket("JWB-2", { status: "In Progress", assignee: owner, ...blockedBy("JWB-7") });
    },
  ],
  [
    "claim_changed",
    (world: World) => world.remote.set(laneRefSchema.parse("interlock-lane:JWB-2"), undefined),
  ],
] as const) {
  test(`a ${edit} ticket is held instead of completed`, async () => {
    const world = new World();
    const merged = world.lane("JWB-2", "approved");
    world.mergedUrls.add(merged.artifact ?? "");
    change(world);

    const report = await superviseTick(world, { ...policy, parallelism: 1 });

    expect(world.log.filter((line) => line.startsWith("complete"))).toEqual([]);
    expect(report.held).toContainEqual({ lane: merged.id, ticket: ref("JWB-2"), reason: edit });
  });
}

test("a reopened ticket with a done lane, or a held claim, is never picked up again", async () => {
  const world = new World();
  world.lane("JWB-2", "done");
  world.ticket("JWB-2");
  world.ticket("JWB-3");
  world.heldTickets.add(ref("JWB-3"));

  const report = await superviseTick(world, policy);

  expect(world.log).toEqual([]);
  expect(report.held).toEqual([
    { ticket: ref("JWB-2"), reason: "reopened" },
    { ticket: ref("JWB-3"), reason: "claim_held" },
  ]);
});

test("a stalled session is resumed once through the host, then routed to attention", async () => {
  const world = new World();
  const lane = world.lane("JWB-2", "implementing");
  world.view(lane, "ready", 3);
  await superviseTick(world, policy);
  world.time = new Date(world.time.getTime() + 31 * 60_000);

  const resumed = await superviseTick(world, policy);
  expect(resumed.resumed).toEqual([{ lane: lane.id, session: `thread-${lane.id}` }]);
  expect(world.log).toEqual([`steer thread-${lane.id} resume:1`]);

  world.time = new Date(world.time.getTime() + 31 * 60_000);
  const stalled = await superviseTick(world, policy);
  expect(stalled.attention).toEqual([{ lane: lane.id, reason: "stalled" }]);
  expect(world.log.slice(1)).toEqual([`attention ${ref("JWB-2")} stalled`]);
});

test("a session that keeps progressing is never steered", async () => {
  const world = new World();
  const lane = world.lane("JWB-2", "implementing");
  for (let messages = 1; messages <= 3; messages += 1) {
    world.view(lane, "running", messages);
    await superviseTick(world, policy);
    world.time = new Date(world.time.getTime() + 31 * 60_000);
  }
  expect(world.log).toEqual([]);
});

test("an unconfirmed resume is never resent after a restart", async () => {
  const world = new World();
  const lane = world.lane("JWB-2", "implementing");
  world.view(lane, "ready", 1);
  world.journal.record(lane.id, {
    kind: "resume_pending",
    operation: [lane.id, "resume:1"],
    session: "thread",
  });

  const report = await superviseTick(world, policy);

  expect(world.log).toEqual([`attention ${ref("JWB-2")} resume_unconfirmed`]);
  expect(report.attention).toEqual([{ lane: lane.id, reason: "resume_unconfirmed" }]);

  world.lanesById.set(lane.id, { ...lane, updatedAt: world.time.toISOString() });
  const resumed = await superviseTick(world, policy);
  expect(resumed.attention).toEqual([]);
  expect(world.log).toHaveLength(1);
});

test("an ambiguous resume routes the lane to attention", async () => {
  const world = new World();
  const lane = world.lane("JWB-2", "implementing");
  world.view(lane, "ready", 1);
  world.steerResult = { state: "ambiguous", reason: "send unconfirmed" };
  await superviseTick(world, policy);
  world.time = new Date(world.time.getTime() + 31 * 60_000);

  await superviseTick(world, policy);

  expect(world.log).toEqual([
    `steer thread-${lane.id} resume:1`,
    `attention ${ref("JWB-2")} resume_unconfirmed`,
  ]);
});

test("unrecoverable completion refusals need attention while transient ones retry", async () => {
  for (const code of ["claim_collision", "recovery_required", "workspace_unknown"] as const) {
    const refused = new World();
    const lane = refused.lane("JWB-2", "approved");
    refused.mergedUrls.add(lane.artifact ?? "");
    refused.completeRefusal = code;
    expect((await superviseTick(refused, policy)).attention).toEqual([
      { lane: lane.id, reason: `completion_${code}` },
    ]);
  }

  const offline = new World();
  const other = offline.lane("JWB-2", "approved");
  offline.mergedUrls.add(other.artifact ?? "");
  offline.completeRefusal = "tracker_unavailable";
  const report = await superviseTick(offline, policy);
  expect(report.attention).toEqual([]);
  expect(report.failures).toEqual([
    { lane: other.id, step: "complete", message: "tracker_unavailable: refused" },
  ]);
  expect(offline.lanesById.get(other.id)?.state).toBe("approved");
});

test("a merged lane with an unreadable recorded configuration fails alone; its siblings still complete", async () => {
  const world = new World();
  const historical = world.lane("JWB-2", "approved");
  const current = world.lane("JWB-3", "approved");
  world.mergedUrls.add(historical.artifact ?? "");
  world.mergedUrls.add(current.artifact ?? "");
  world.configurationErrors.set(historical.id, "version 1 refused");

  const report = await superviseTick(world, policy);

  expect(report.failures).toEqual([
    { lane: historical.id, step: "approved", message: "version 1 refused" },
  ]);
  expect(report.completed.map((item) => item.ticket)).toEqual([ref("JWB-3")]);
  expect(world.lanesById.get(historical.id)?.state).toBe("approved");
});

test("a failed launch stops launching for the tick", async () => {
  const world = new World();
  world.ticket("JWB-3");
  world.ticket("JWB-4");
  world.launchFailure = "host_unavailable: t3 is down";

  const report = await superviseTick(world, policy);

  expect(world.log).toEqual([`launch ${ref("JWB-3")}`]);
  expect(report.failures).toEqual([
    { ticket: ref("JWB-3"), step: "launch", message: "host_unavailable: t3 is down" },
  ]);
});

test("gate evidence is journaled only when the observed value changes", async () => {
  const world = new World();
  const lane = world.lane("JWB-2", "approved");
  await superviseTick(world, policy);
  await superviseTick(world, policy);
  const gates = () =>
    (world.journalEntries.get(lane.id) ?? []).flatMap((entry) =>
      entry.kind === "gate" && entry.evidence.gate === "merge" ? [entry.evidence.observed] : [],
    );
  expect(gates()).toEqual([{ value: false }]);

  world.mergedUrls.add(lane.artifact ?? "");
  await superviseTick(world, policy);
  expect(gates()).toEqual([{ value: false }, { value: "b".repeat(40) }]);
});

test("a session the host cannot find, finds twice or cannot read needs attention after repeated misses", async () => {
  const tickThrice = async (world: World) => {
    const reports = [];
    for (let tick = 0; tick < 3; tick += 1) reports.push(await superviseTick(world, policy));
    return reports;
  };
  const missing = new World();
  const lane = missing.lane("JWB-2", "implementing");
  const reports = await tickThrice(missing);
  expect(reports.map((report) => report.attention)).toEqual([
    [],
    [],
    [{ lane: lane.id, reason: "session_missing" }],
  ]);
  expect(reports[0]?.failures).toEqual([
    {
      lane: lane.id,
      step: "session",
      message: "session_missing: Host reports 0 sessions for the lane",
    },
  ]);

  const doubled = new World();
  const other = doubled.lane("JWB-2", "implementing");
  const view = doubled.view(other, "ready", 1);
  doubled.sessions = async () => [view, view];
  expect((await tickThrice(doubled))[2]?.attention).toEqual([
    { lane: other.id, reason: "session_ambiguous" },
  ]);

  const offline = new World();
  const third = offline.lane("JWB-2", "implementing");
  offline.sessions = async () => {
    throw new Error("host_unavailable: T3 thread thread-1 is unreadable");
  };
  expect((await tickThrice(offline))[2]?.attention).toEqual([
    { lane: third.id, reason: "session_unreachable" },
  ]);
});

test("a session seen between misses resets the miss count", async () => {
  const world = new World();
  const lane = world.lane("JWB-2", "implementing");
  await superviseTick(world, policy);
  await superviseTick(world, policy);
  world.view(lane, "running", 1);
  await superviseTick(world, policy);
  world.views.delete(lane.id);
  const reports = [await superviseTick(world, policy), await superviseTick(world, policy)];
  expect(reports.map((report) => report.attention)).toEqual([[], []]);
});

test("a lane without a resolvable claim, or whose run needs recovery, needs attention", async () => {
  const world = new World();
  const unclaimed = world.lane("JWB-2", "implementing");
  world.claims.delete(unclaimed.id);
  world.view(unclaimed, "ready", 1);
  const recovering = world.lane("JWB-3", "implementing");
  world.view(recovering, "ready", 1);
  const lanes = world.lanes;
  world.lanes = () =>
    lanes().map((supervised) =>
      supervised.lane.id === recovering.id ? { ...supervised, recoveryRequired: true } : supervised,
    );

  const report = await superviseTick(world, policy);

  expect(report.held).toEqual([]);
  expect(report.attention).toEqual([
    { lane: unclaimed.id, reason: "claim_unrecorded" },
    { lane: recovering.id, reason: "recovery_required" },
  ]);
  expect(world.log).toEqual([`attention ${ref("JWB-2")} claim_unrecorded`]);
});

test("a human edit holds a running session instead of resuming it", async () => {
  const world = new World();
  const lane = world.lane("JWB-2", "implementing");
  world.view(lane, "ready", 1);
  await superviseTick(world, policy);
  world.ticket("JWB-2", { status: "In Progress", assignee: actorRefSchema.parse("someone") });
  world.time = new Date(world.time.getTime() + 31 * 60_000);

  const report = await superviseTick(world, policy);

  expect(world.log).toEqual([]);
  expect(report.held).toEqual([{ lane: lane.id, ticket: ref("JWB-2"), reason: "reassigned" }]);
});

test("a person resuming a stalled lane gets a fresh stall window and resume", async () => {
  const world = new World();
  const lane = world.lane("JWB-2", "implementing");
  world.view(lane, "ready", 1);
  for (let tick = 0; tick < 3; tick += 1) {
    await superviseTick(world, policy);
    world.time = new Date(world.time.getTime() + 31 * 60_000);
  }
  expect(world.lanesById.get(lane.id)?.state).toBe("attention");
  world.lanesById.set(lane.id, { ...lane, updatedAt: world.time.toISOString() });

  expect((await superviseTick(world, policy)).attention).toEqual([]);
  world.time = new Date(world.time.getTime() + 31 * 60_000);
  expect((await superviseTick(world, policy)).resumed).toHaveLength(1);
  expect(world.log).toEqual([
    `steer thread-${lane.id} resume:1`,
    `attention ${ref("JWB-2")} stalled`,
    `steer thread-${lane.id} resume:2`,
  ]);
});

test("--only acts on and counts only the named tickets' lanes", async () => {
  const world = new World();
  const merged = world.lane("JWB-2", "approved");
  world.mergedUrls.add(merged.artifact ?? "");
  const stalled = world.lane("JWB-9", "implementing");
  world.view(stalled, "ready", 1);
  const outsider = world.lane("JWB-8", "approved");
  world.mergedUrls.add(outsider.artifact ?? "");
  world.ticket("JWB-3", blockedBy("JWB-2"));
  world.ticket("JWB-4", blockedBy("JWB-2"));
  const only = { ...policy, parallelism: 1, only: ["JWB-2", "JWB-4"] };

  const report = await superviseTick(world, only);
  world.time = new Date(world.time.getTime() + 31 * 60_000);
  await superviseTick(world, only);

  expect(world.log).toEqual([`complete ${ref("JWB-2")}`, `launch ${ref("JWB-4")}`]);
  expect(report.evidence.map((item) => item.lane)).not.toContain(stalled.id);
  expect(world.lanesById.get(outsider.id)?.state).toBe("approved");
});

test("without --only, lanes whose tickets are outside the project maps are ignored and uncounted", async () => {
  const world = new World();
  const foreign = world.lane("JWB-50", "approved");
  world.mergedUrls.add(foreign.artifact ?? "");
  const busy = world.lane("JWB-51", "implementing");
  world.outsideMap.add(ref("JWB-50"));
  world.outsideMap.add(ref("JWB-51"));
  world.ticket("JWB-3");

  const report = await superviseTick(world, { ...policy, parallelism: 1 });

  expect(world.log).toEqual([`launch ${ref("JWB-3")}`]);
  expect(report.failures).toEqual([]);
  expect(report.attention).toEqual([]);
  expect(world.lanesById.get(foreign.id)?.state).toBe("approved");
  expect(world.lanesById.get(busy.id)?.state).toBe("implementing");
});

test("a map that cannot be listed for scoping blocks every launch that tick", async () => {
  const world = new World();
  const busy = world.lane("JWB-2", "implementing");
  world.view(busy, "running", 1);
  world.ticket("JWB-3");
  const list = world.frontier;
  let calls = 0;
  world.frontier = async () => {
    calls += 1;
    if (calls === 1) throw new Error("jira_unavailable");
    return list();
  };

  const report = await superviseTick(world, { ...policy, parallelism: 1 });

  expect(world.log).toEqual([]);
  expect(report.failures).toEqual([
    { step: "scope", message: `${map}: jira_unavailable; no launches this tick` },
  ]);
});
