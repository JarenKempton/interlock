import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runCli } from "../../../src/main.ts";
import {
  adapterRefSchema,
  laneRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../../../src/domain/refs/identifiers.ts";
import {
  createLane,
  isUnattached,
  type Lane,
  nextLaneAction,
  transitionLane,
} from "../../../src/domain/lane/lifecycle.ts";
import type { Ticket } from "../../../src/domain/tracker/ticket.ts";
import type { ArtifactHost } from "../../../src/domain/submission/artifact.ts";
import { LaneService, type LaneTrackerPort } from "../../../src/execution/lane/service.ts";
import { StateStore } from "../../../src/persistence/state.ts";
import { gitLaneService } from "../../../src/app/lane/service.ts";

const proof = {
  merged: true,
  url: "https://example.test/pr/1",
  repository: "github.com/o/r",
  branch: "task/A-1",
  head: "abc",
  base: "main",
  commit: "def",
};
const now = "2026-01-01T00:00:00.000Z";
const ticketRef = ticketRefSchema.parse("jira:x:W:ticket:A-1");
const evidence = [{ gate: "test", head: "abc", url: "https://example.test/1" }];

const attach = { type: "attach", run: "interlock-run:1", claim: "interlock-claim:1" } as const;

function domainLane(maxReviewRounds = 3): Lane {
  return {
    ...createLane({ id: laneRefSchema.parse("interlock-lane:domain"), ticket: ticketRef }, now),
    maxReviewRounds,
  };
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
  return drive(lane, attach);
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

test("create starts an unattached implementing lane that attach binds once", () => {
  const lane = domainLane();
  expect(lane).toMatchObject({ ticket: ticketRef, state: "implementing", maxReviewRounds: 3 });
  expect(lane.run).toBeUndefined();
  expect(isUnattached(lane)).toBe(true);
  const attached = drive(lane, attach);
  expect(attached).toMatchObject({
    state: "implementing",
    run: "interlock-run:1",
    claim: "interlock-claim:1",
  });
  expect(isUnattached(attached)).toBe(false);
  expect(transitionLane(attached, attach, now).refusal?.code).toBe("invalid_transition");
  const held = drive(lane, { type: "attention", reason: "session_missing" });
  expect(transitionLane(held, attach, now).refusal?.code).toBe("invalid_transition");
});

test("happy path walks every state and next returns exactly one action per state", () => {
  let lane = domainLane();
  expect(nextLaneAction(lane)).toEqual({ kind: "implement", lane: lane.id });
  lane = drive(lane, attach);
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
  expect(nextLaneAction(lane).kind).toBe("verify_done");
  lane = drive(lane, { type: "complete", proof, trackerDoneVerified: true });
  expect(lane.state).toBe("done");
  expect(nextLaneAction(lane).kind).toBe("none");
});

test("an unattached lane cannot submit", () => {
  expect(
    transitionLane(domainLane(), { type: "submit", artifact: "a", head: "abc", evidence }, now)
      .refusal?.code,
  ).toBe("invalid_transition");
});

test("every out-of-state transition is refused with a machine-readable code", () => {
  const lane = domainLane();
  const commands: Parameters<typeof transitionLane>[1][] = [
    { type: "submit", artifact: "a", head: "abc", evidence },
    { type: "begin_review" },
    { type: "verdict", head: "abc", decision: "approved", findings: [] },
    { type: "complete", proof, trackerDoneVerified: true },
    { type: "resume" },
  ];
  for (const command of commands) {
    const result = transitionLane(lane, command, now);
    expect(result.refusal?.code).toBe("invalid_transition");
    expect(result.lane).toBe(lane);
  }
  const done = drive(approved(domainLane()), {
    type: "complete",
    proof,
    trackerDoneVerified: true,
  });
  for (const command of [...commands, attach]) {
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
  const result = transitionLane(
    lane,
    { type: "complete", trackerDoneVerified: true, proof: { ...proof, head: "new-head" } },
    now,
  );
  expect(result.refusal?.code).toBe("stale_evidence");
  expect(result.lane).toBe(lane);
});

test("complete requires verified tracker completion at the domain gate", () => {
  const merged = { ...approved(domainLane()), state: "merged" as const };
  const refused = transitionLane(
    merged,
    { type: "complete", proof, trackerDoneVerified: false },
    now,
  );
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
    };
  }

  async read() {
    if (this.failRead) throw new Error("readback unavailable");
    return { ticket: this.ticket, snapshot: { version: "1", payload: null } };
  }

  async complete(_ticket: Ticket["ref"]) {
    const status = "Done";
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
  const service = gitLaneService({
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

function attachedLane(store: StateStore, id = "interlock-lane:test-1"): Lane {
  const lane = implementing(createLane({ id: laneRefSchema.parse(id), ticket: ticketRef }, now));
  store.saveLane(lane);
  return lane;
}

async function serviceLaneToApproved(service: LaneService, store: StateStore) {
  const id = attachedLane(store).id;
  for (const command of [
    { type: "submit", artifact: "https://example.test/pr/1", head: "abc", evidence },
    { type: "begin_review" },
    { type: "verdict", head: "abc", decision: "approved", findings: [] },
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
      type: "begin_review",
    });
    expect(missing).toEqual({
      ok: false,
      refusal: { code: "lane_not_found", message: expect.any(String) },
    });
    const id = await serviceLaneToApproved(service, store);
    expect(service.get(id)).toMatchObject({ ok: true, value: { state: "approved" } });
    expect(service.next(id)).toEqual({ ok: true, value: { kind: "verify_done", lane: id } });
    store.close();
    const reopened = new StateStore(path);
    try {
      expect(reopened.lane(id).state).toBe("approved");
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

test("completion without a recorded run refuses before tracker writes", async () => {
  const tracker = new FakeTracker();
  const { service, store, cleanup } = makeService(tracker);
  try {
    const id = await serviceLaneToApproved(service, store);
    expect(
      await service.apply(id, { type: "complete", proof, trackerDoneVerified: false }),
    ).toMatchObject({ ok: false, refusal: { code: "unsupported_capability" } });
    expect(tracker.transitions).toEqual([]);
  } finally {
    cleanup();
  }
});

test("CLI reviews an attached lane and refuses completion without an owned claim", async () => {
  const directory = mkdtempSync(join(tmpdir(), "interlock-lane-cli-"));
  const statePath = join(directory, "interlock.db");
  const seed = new StateStore(statePath);
  seed.saveRun({
    ref: runRefSchema.parse("interlock-run:cli"),
    ticket: ticketRef,
    host: adapterRefSchema.parse("t3"),
    harness: adapterRefSchema.parse("t3"),
    workspace: { path: directory, branch: "local/cli" },
    status: "claimed",
    createdAt: now,
    updatedAt: now,
  });
  const seeded = drive(
    createLane({ id: laneRefSchema.parse("interlock-lane:cli"), ticket: ticketRef }, now),
    { type: "attach", run: "interlock-run:cli", claim: "interlock-claim:cli" },
    { type: "submit", artifact: "https://example.test/pr/1", head: "abc", evidence },
  );
  seed.saveLane(seeded);
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
    update: async () => ({ url: "https://example.test/pr/1", branch: "local/cli", state: "OPEN" }),
  };
  const services = { statePath, lane: { artifacts } };
  try {
    const call = async (args: string[]) => {
      const output: string[] = [];
      const code = await runCli(args, (text) => output.push(text), services);
      return { code, value: JSON.parse(output.join("\n")) };
    };
    const id: string = seeded.id;
    expect((await call(["lane", "next", id, "--json"])).value.value.kind).toBe("review");
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
    const completed = await call(["lane", "complete", id, "--json"]);
    expect(completed.value).toMatchObject({
      ok: false,
      refusal: { code: "unsupported_capability" },
    });
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
  );
  expect(lane.state).toBe("approved");
});

test("granting a round resumes a lane held at its round limit and allows one more round", () => {
  let lane = drive(
    submitted(domainLane(1)),
    { type: "begin_review" },
    { type: "verdict", head: "abc", decision: "changes_requested", findings: ["one"] },
  );
  expect(lane).toMatchObject({ state: "attention", attentionReason: "review_round_limit" });
  lane = drive(lane, { type: "grant_round" });
  expect(lane).toMatchObject({ state: "implementing", maxReviewRounds: 2, reviewRound: 1 });
  expect(lane.attentionReason).toBeUndefined();
  lane = drive(lane, {
    type: "submit",
    artifact: "https://example.test/pr/1",
    head: "def",
    evidence: [{ gate: "test", head: "def", url: "https://example.test/2" }],
  });
  expect(lane).toMatchObject({ state: "submitted", reviewRound: 2 });
  const reviewing = drive(lane, { type: "begin_review" });
  expect(drive(reviewing, { type: "grant_round" })).toMatchObject({
    state: "reviewing",
    maxReviewRounds: 3,
  });
});

test("CLI lane grant-round records the grant in the ledger", async () => {
  const directory = mkdtempSync(join(tmpdir(), "interlock-lane-grant-"));
  const statePath = join(directory, "interlock.db");
  const run = runRefSchema.parse("interlock-run:grant");
  const seed = new StateStore(statePath);
  seed.saveRun({
    ref: run,
    ticket: ticketRef,
    host: adapterRefSchema.parse("t3"),
    harness: adapterRefSchema.parse("t3"),
    workspace: { path: directory, branch: "task/A-1" },
    status: "claimed",
    createdAt: now,
    updatedAt: now,
  });
  const held = drive(
    createLane({ id: laneRefSchema.parse("interlock-lane:grant"), ticket: ticketRef }, now),
    { type: "attach", run, claim: "interlock-claim:grant" },
    { type: "submit", artifact: "https://example.test/pr/1", head: "abc", evidence },
    { type: "attention", reason: "review_round_limit" },
  );
  seed.saveLane({ ...held, previousState: "implementing" });
  seed.close();
  try {
    const output: string[] = [];
    const code = await runCli(
      ["lane", "grant-round", "--ticket", "A-1", "--state", statePath, "--json"],
      (text) => output.push(text),
      {},
    );
    expect(code).toBe(0);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      ok: true,
      value: { state: "implementing", maxReviewRounds: 4 },
    });
    const store = new StateStore(statePath);
    try {
      expect(
        store.steps(run).map((step) => [step.state, JSON.parse(step.receipt_json ?? "")]),
      ).toEqual([
        [
          "review_round_granted",
          { lane: held.id, reviewRound: 1, maxReviewRounds: 4, state: "implementing" },
        ],
      ]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
