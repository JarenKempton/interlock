import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runCli } from "../src/cli.ts";
import {
  adapterRefSchema,
  laneRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../src/domain/identifiers.ts";
import { createLane, type Lane, nextLaneAction, transitionLane } from "../src/domain/lane.ts";
import type { Ticket } from "../src/domain/model.ts";
import type { ArtifactHost } from "../src/execution/lane.ts";
import { LaneService, type LaneTrackerPort } from "../src/execution/lane.ts";
import { StateStore } from "../src/persistence/state.ts";
import { FakeSubmissionAuthority } from "./fixtures/submission.ts";

const now = "2026-01-01T00:00:00.000Z";
const ticketRef = ticketRefSchema.parse("jira:x:W:ticket:A-1");
const otherTicketRef = ticketRefSchema.parse("jira:x:W:ticket:A-2");
const evidence = [{ gate: "test", head: "abc", url: "https://example.test/1" }];

function domainLane(maxReviewRounds = 3): Lane {
  const created = createLane(
    { id: laneRefSchema.parse("interlock-lane:domain"), ticket: ticketRef, maxReviewRounds },
    now,
  );
  if (created.refusal) throw new Error(created.refusal.message);
  return created.lane;
}

function drive(lane: Lane, ...commands: Parameters<typeof transitionLane>[1][]): Lane {
  let current = lane;
  for (const command of commands) {
    const result = transitionLane(current, command, now);
    if (result.refusal) throw new Error(`${command.type}: ${result.refusal.message}`);
    current = result.lane;
  }
  return current;
}

function implementing(lane: Lane): Lane {
  return drive(
    lane,
    { type: "claim", run: "interlock-run:1", claim: "interlock-claim:1" },
    { type: "start" },
  );
}

function submitted(lane: Lane, head = "abc"): Lane {
  return drive(implementing(lane), {
    type: "submit",
    artifact: "https://example.test/pr/1",
    head,
    evidence: evidence.map((item) => ({ ...item, head })),
  });
}

function approved(lane: Lane): Lane {
  return drive(
    submitted(lane),
    { type: "begin_review" },
    {
      type: "verdict",
      head: "abc",
      decision: "approved",
      findings: [],
    },
  );
}

test("create requires a ticket or title and a positive round limit", () => {
  expect(createLane({ id: laneRefSchema.parse("interlock-lane:x") }, now).refusal?.code).toBe(
    "gates_unmet",
  );
  expect(
    createLane(
      { id: laneRefSchema.parse("interlock-lane:x"), title: "One off", maxReviewRounds: 0 },
      now,
    ).refusal?.code,
  ).toBe("gates_unmet");
  const local = createLane({ id: laneRefSchema.parse("interlock-lane:x"), title: "One off" }, now);
  expect(local.refusal).toBeUndefined();
  expect(local.lane.state).toBe("queued");
  expect(local.lane.ticket).toBeUndefined();
});

test("happy path walks every state and next returns exactly one action per state", () => {
  let lane = domainLane();
  expect(nextLaneAction(lane)).toEqual({ kind: "claim", lane: lane.id });
  lane = drive(lane, { type: "claim", run: "interlock-run:1", claim: "interlock-claim:1" });
  expect(lane.state).toBe("claimed");
  expect(nextLaneAction(lane).kind).toBe("implement");
  lane = drive(lane, { type: "start" });
  expect(lane.state).toBe("implementing");
  expect(nextLaneAction(lane).kind).toBe("implement");
  lane = drive(lane, {
    type: "submit",
    artifact: "https://example.test/pr/1",
    head: "abc",
    evidence,
  });
  expect(lane.state).toBe("submitted");
  expect(nextLaneAction(lane).kind).toBe("review");
  lane = drive(lane, { type: "begin_review" });
  expect(nextLaneAction(lane)).toEqual({ kind: "record_verdict", lane: lane.id, head: "abc" });
  lane = drive(lane, { type: "verdict", head: "abc", decision: "approved", findings: [] });
  expect(lane.state).toBe("approved");
  expect(nextLaneAction(lane)).toEqual({ kind: "merge", lane: lane.id, head: "abc" });
  lane = drive(lane, { type: "merge", head: "abc" });
  expect(lane.state).toBe("merged");
  expect(nextLaneAction(lane).kind).toBe("verify_done");
  lane = drive(lane, { type: "complete", trackerDoneVerified: true });
  expect(lane.state).toBe("done");
  expect(nextLaneAction(lane).kind).toBe("none");
});

test("every out-of-state transition is refused with a machine-readable code", () => {
  const lane = domainLane();
  const commands: Parameters<typeof transitionLane>[1][] = [
    { type: "start" },
    { type: "submit", artifact: "a", head: "abc", evidence },
    { type: "begin_review" },
    { type: "verdict", head: "abc", decision: "approved", findings: [] },
    { type: "merge", head: "abc" },
    { type: "complete", trackerDoneVerified: true },
    { type: "resume" },
  ];
  for (const command of commands) {
    const result = transitionLane(lane, command, now);
    expect(result.refusal?.code).toBe("invalid_transition");
    expect(result.lane).toBe(lane);
  }
  const done = drive(
    approved(domainLane()),
    { type: "merge", head: "abc" },
    {
      type: "complete",
      trackerDoneVerified: true,
    },
  );
  for (const command of commands) {
    expect(transitionLane(done, command, now).refusal?.code).toBe("invalid_transition");
  }
});

test("submit enforces artifact, head and head-bound evidence gates", () => {
  const lane = implementing(domainLane());
  expect(
    transitionLane(lane, { type: "submit", artifact: " ", head: "abc", evidence }, now).refusal
      ?.code,
  ).toBe("artifact_required");
  expect(
    transitionLane(lane, { type: "submit", artifact: "a", head: " ", evidence: [] }, now).refusal
      ?.code,
  ).toBe("gates_unmet");
  expect(
    transitionLane(lane, { type: "submit", artifact: "a", head: "abc", evidence: [] }, now).refusal
      ?.code,
  ).toBe("gates_unmet");
  expect(
    transitionLane(
      lane,
      {
        type: "submit",
        artifact: "a",
        head: "abc",
        evidence: [{ gate: "test", head: "other", url: "https://example.test" }],
      },
      now,
    ).refusal?.code,
  ).toBe("stale_evidence");
  expect(
    transitionLane(
      lane,
      {
        type: "submit",
        artifact: "a",
        head: "abc",
        evidence: [{ gate: " ", head: "abc", url: "https://example.test" }],
      },
      now,
    ).refusal?.code,
  ).toBe("gates_unmet");
});

test("one lane keeps one artifact across review rounds", () => {
  let lane = submitted(domainLane());
  lane = drive(
    lane,
    { type: "begin_review" },
    {
      type: "verdict",
      head: "abc",
      decision: "changes_requested",
      findings: ["fix it"],
    },
  );
  expect(lane.state).toBe("implementing");
  const refused = transitionLane(
    lane,
    {
      type: "submit",
      artifact: "https://example.test/pr/2",
      head: "def",
      evidence: [{ gate: "test", head: "def", url: "https://example.test/2" }],
    },
    now,
  );
  expect(refused.refusal?.code).toBe("artifact_mismatch");
  const resubmitted = transitionLane(
    lane,
    {
      type: "submit",
      artifact: "https://example.test/pr/1",
      head: "def",
      evidence: [{ gate: "test", head: "def", url: "https://example.test/2" }],
    },
    now,
  );
  expect(resubmitted.refusal).toBeUndefined();
  expect(resubmitted.lane.head).toBe("def");
  expect(resubmitted.lane.verdict).toBeUndefined();
});

test("verdicts are bound to the submitted head", () => {
  const reviewing = drive(submitted(domainLane()), { type: "begin_review" });
  const stale = transitionLane(
    reviewing,
    { type: "verdict", head: "other", decision: "approved", findings: [] },
    now,
  );
  expect(stale.refusal?.code).toBe("stale_evidence");
  expect(stale.lane.state).toBe("reviewing");
  expect(
    transitionLane(
      reviewing,
      { type: "verdict", head: "abc", decision: "changes_requested", findings: [] },
      now,
    ).refusal?.code,
  ).toBe("gates_unmet");
});

test("changes_requested loops to implementing until the round limit routes to attention", () => {
  let lane = submitted(domainLane(2));
  lane = drive(
    lane,
    { type: "begin_review" },
    {
      type: "verdict",
      head: "abc",
      decision: "changes_requested",
      findings: ["one"],
    },
  );
  expect(lane.state).toBe("implementing");
  lane = drive(
    lane,
    {
      type: "submit",
      artifact: "https://example.test/pr/1",
      head: "def",
      evidence: [{ gate: "test", head: "def", url: "https://example.test/2" }],
    },
    { type: "begin_review" },
    { type: "verdict", head: "def", decision: "changes_requested", findings: ["two"] },
  );
  expect(lane.state).toBe("attention");
  expect(lane.attentionReason).toBe("review_round_limit");
  expect(nextLaneAction(lane)).toEqual({
    kind: "attention",
    lane: lane.id,
    reason: "review_round_limit",
  });
  lane = drive(lane, { type: "resume" });
  expect(lane.state).toBe("implementing");
});

test("an approval goes stale when the head changes before merge", () => {
  const lane = approved(domainLane());
  const result = transitionLane(lane, { type: "merge", head: "new-head" }, now);
  expect(result.refusal?.code).toBe("stale_evidence");
  expect(result.lane.state).toBe("implementing");
  expect(result.lane.verdict).toBeUndefined();
  expect(nextLaneAction(result.lane).kind).toBe("implement");
});

test("complete requires verified tracker completion at the domain gate", () => {
  const merged = drive(approved(domainLane()), { type: "merge", head: "abc" });
  const refused = transitionLane(merged, { type: "complete", trackerDoneVerified: false }, now);
  expect(refused.refusal?.code).toBe("tracker_not_done");
  expect(refused.lane.state).toBe("merged");
});

test("attention routes to the user and resume restores the previous state", () => {
  const lane = implementing(domainLane());
  const held = transitionLane(lane, { type: "attention", reason: "needs decision" }, now);
  expect(held.lane.state).toBe("attention");
  expect(nextLaneAction(held.lane)).toEqual({
    kind: "attention",
    lane: lane.id,
    reason: "needs decision",
  });
  expect(transitionLane(held.lane, { type: "attention", reason: "again" }, now).refusal?.code).toBe(
    "invalid_transition",
  );
  const resumed = transitionLane(held.lane, { type: "resume" }, now);
  expect(resumed.lane.state).toBe("implementing");
  expect(resumed.lane.attentionReason).toBeUndefined();
});

class FakeTracker implements LaneTrackerPort {
  ticket: Ticket;
  transitions: string[] = [];
  failRead = false;
  failTransition = false;
  markDoneOnTransition = true;

  constructor(status = "In Progress", state: Ticket["state"] = "open") {
    this.ticket = {
      ref: ticketRef,
      map: mapRefSchema.parse("jira:x:W:map:M-1"),
      kind: "task",
      state,
      status,
      order: 0,
    };
  }

  async read() {
    if (this.failRead) throw new Error("readback unavailable");
    return { ticket: this.ticket, snapshot: { version: "1", payload: null } };
  }

  async transition(_ticket: Ticket["ref"], status: string) {
    this.transitions.push(status);
    if (this.failTransition) throw new Error("transition failed");
    if (this.markDoneOnTransition) this.ticket = { ...this.ticket, state: "closed", status };
  }
}

function makeService(tracker?: LaneTrackerPort) {
  const directory = mkdtempSync(join(tmpdir(), "interlock-lane-"));
  const path = join(directory, "interlock.db");
  const store = new StateStore(path);
  let sequence = 0;
  const service = new LaneService({
    store,
    ...(tracker ? { tracker } : {}),
    newId: () => laneRefSchema.parse(`interlock-lane:test-${++sequence}`),
  });
  return {
    service,
    store,
    path,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function serviceLaneToMerged(service: LaneService, ticket?: string) {
  const created = service.create(ticket ? { ticket } : { title: "One off" });
  if (!created.ok) throw new Error(created.refusal.message);
  const id = created.value.id;
  for (const command of [
    { type: "claim", run: "interlock-run:1", claim: "interlock-claim:1" },
    { type: "start" },
    { type: "submit", artifact: "https://example.test/pr/1", head: "abc", evidence },
    { type: "begin_review" },
    { type: "verdict", head: "abc", decision: "approved", findings: [] },
    { type: "merge", head: "abc" },
  ] as const) {
    const result = await service.apply(id, command);
    if (!result.ok) throw new Error(`${command.type}: ${result.refusal.message}`);
  }
  return id;
}

test("service persists lanes and refuses unknown lanes", async () => {
  const { service, store, path, cleanup } = makeService();
  try {
    const missing = await service.apply(laneRefSchema.parse("interlock-lane:missing"), {
      type: "start",
    });
    expect(missing).toEqual({
      ok: false,
      refusal: { code: "lane_not_found", message: expect.any(String) },
    });
    const id = await serviceLaneToMerged(service);
    expect(service.get(id)).toMatchObject({ ok: true, value: { state: "merged" } });
    expect(service.next(id)).toEqual({ ok: true, value: { kind: "verify_done", lane: id } });
    store.close();
    const reopened = new StateStore(path);
    try {
      expect(reopened.lane(id).state).toBe("merged");
      expect(reopened.lane(id).evidence).toEqual(evidence);
    } finally {
      reopened.close();
    }
  } finally {
    try {
      cleanup();
    } catch {}
  }
});

test("service refuses a second active lane for a ticket and promotion collisions", async () => {
  const { service, cleanup } = makeService();
  try {
    expect(service.create({ ticket: String(ticketRef) }).ok).toBe(true);
    const duplicate = service.create({ ticket: String(ticketRef) });
    expect(duplicate).toMatchObject({ ok: false, refusal: { code: "claim_collision" } });
    const local = service.create({ title: "Local task" });
    if (!local.ok) throw new Error("local lane");
    const promoted = await service.apply(local.value.id, {
      type: "promote",
      ticket: otherTicketRef,
    });
    expect(promoted).toMatchObject({ ok: true, value: { ticket: otherTicketRef } });
    expect(
      await service.apply(local.value.id, { type: "promote", ticket: otherTicketRef }),
    ).toMatchObject({ ok: false, refusal: { code: "invalid_transition" } });
    const secondLocal = service.create({ title: "Another local" });
    if (!secondLocal.ok) throw new Error("second local lane");
    expect(
      await service.apply(secondLocal.value.id, { type: "promote", ticket: ticketRef }),
    ).toMatchObject({ ok: false, refusal: { code: "claim_collision" } });
  } finally {
    cleanup();
  }
});

test("completion without a recorded run refuses before tracker writes", async () => {
  const tracker = new FakeTracker();
  const { service, cleanup } = makeService(tracker);
  try {
    const id = await serviceLaneToMerged(service, String(ticketRef));
    expect(await service.apply(id, { type: "complete", trackerDoneVerified: false })).toMatchObject(
      { ok: false, refusal: { code: "workspace_unknown" } },
    );
    expect(tracker.transitions).toEqual([]);
  } finally {
    cleanup();
  }
});

test("CLI runs a one-off lane and refuses completion without an owned claim", async () => {
  const directory = mkdtempSync(join(tmpdir(), "interlock-lane-cli-"));
  const statePath = join(directory, "interlock.db");
  const seed = new StateStore(statePath);
  seed.saveRun({
    ref: runRefSchema.parse("interlock-run:cli"),
    ticket: ticketRef,
    harness: adapterRefSchema.parse("t3"),
    workspace: { path: directory, branch: "local/cli" },
    capabilities: {},
    status: "claimed",
    createdAt: now,
    updatedAt: now,
  });
  seed.close();
  const artifacts: ArtifactHost = {
    prepare: async (workspace, head) => ({
      ...workspace,
      head,
      remote: "https://github.com/o/r.git",
      repository: "github.com/o/r",
    }),
    push: async () => {},
    pullRequests: async () => [],
    open: async () => ({ url: "https://example.test/pr/1", branch: "local/cli", state: "OPEN" }),
  };
  const services = { statePath, lane: { artifacts, submissions: new FakeSubmissionAuthority() } };
  try {
    const call = async (args: string[]) => {
      const output: string[] = [];
      const code = await runCli(args, (text) => output.push(text), services);
      return { code, value: JSON.parse(output.join("\n")) };
    };
    const created = await call(["lane", "create", "--title", "Local CLI task", "--json"]);
    expect(created.code).toBe(0);
    const id: string = created.value.value.id;
    expect(created.value.value.state).toBe("queued");
    expect((await call(["lane", "next", id, "--json"])).value.value.kind).toBe("claim");
    expect((await call(["lane", "start", id, "--json"])).code).toBe(1);
    await call(["lane", "claim", id, "--run", "interlock-run:cli", "--json"]);
    await call(["lane", "start", id, "--json"]);
    await call([
      "lane",
      "submit",
      id,
      "--head",
      "abc",
      "--gate",
      "test",
      "--evidence-url",
      "https://example.test/1",
      "--json",
    ]);
    await call(["lane", "review", id, "--json"]);
    const verdict = await call([
      "lane",
      "verdict",
      id,
      "--head",
      "abc",
      "--decision",
      "approved",
      "--json",
    ]);
    expect(verdict.value.value.state).toBe("approved");
    await call(["lane", "merge", id, "--head", "abc", "--json"]);
    const completed = await call(["lane", "complete", id, "--json"]);
    expect(completed.value).toMatchObject({ ok: false, refusal: { code: "workspace_unknown" } });
    expect((await call(["lane", "next", id, "--json"])).value.value.kind).toBe("verify_done");
    const listed = await call(["lane", "list", "--json"]);
    expect(listed.value).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the no-lens procedure reaches merge: review, attention, resume, then a person's verdict", () => {
  const lane = drive(
    implementing(domainLane()),
    { type: "submit", artifact: "https://github.com/o/r/pull/1", head: "abc", evidence },
    { type: "begin_review" },
    { type: "attention", reason: "review_required" },
    { type: "resume" },
    { type: "verdict", head: "abc", decision: "approved", findings: [] },
    { type: "merge", head: "abc" },
  );
  expect(lane.state).toBe("merged");
});
