import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApplication } from "../../../src/app/application.ts";
import { StateStore } from "../../../src/persistence/state.ts";
import { GIT_TEST_TIMEOUT_MS } from "../../fixtures/git/remote.ts";
import { inspect, lock, pickupRuntimeFixtures, ref } from "../../fixtures/pickup/runtime-suite.ts";
import { rejection } from "../../fixtures/assertions/rejection.ts";
import { launchable } from "../../fixtures/host/scripted-t3.ts";
import { updateUserSettings } from "../../../src/configuration/store.ts";
import { createLane, transitionLane } from "../../../src/domain/lane/lifecycle.ts";
import {
  adapterRefSchema,
  claimRefSchema,
  laneRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../../../src/domain/refs/identifiers.ts";

const fixture = pickupRuntimeFixtures();

async function supervised() {
  const f = await fixture();
  mkdirSync(dirname(f.state), { recursive: true });
  const store = new StateStore(f.state);
  updateUserSettings(store, (settings) => ({
    ...settings,
    jira_site: "https://example.atlassian.net",
  }));
  store.close();
  const { t3 } = launchable(f);
  const tick = async () => {
    const report = await createApplication(f.services).run.execute({
      project: `TEST-470=${f.remote.alice}`,
      once: true,
      state: f.state,
    });
    if (typeof report === "string") throw new Error(report);
    return report;
  };
  const starts = () => t3.calls.filter((call) => call[1] === "start");
  return { f, tick, starts, t3 };
}

test(
  "run --once picks up and launches an unblocked frontier ticket, and a restart never relaunches it",
  async () => {
    const { f, tick, starts } = await supervised();

    const first = await tick();
    expect(first).toMatchObject({
      launched: [{ ticket: ref, session: "thread-1" }],
      failures: [],
    });
    expect(starts()).toHaveLength(1);
    const lane = inspect(f, (store) => store.laneForTicket(ref));
    expect(lane).toMatchObject({ state: "implementing" });
    expect(lane?.run).toBeUndefined();
    expect(inspect(f, (store) => store.listRuns().map((run) => [run.ticket, run.status]))).toEqual([
      [ref, "claimed"],
    ]);

    const restarted = await tick();
    expect(restarted).toMatchObject({ launched: [], failures: [], held: [], attention: [] });
    expect(starts()).toHaveLength(1);

    const status = await createApplication(f.services).status.execute({ state: f.state });
    expect(status).toEqual([
      expect.objectContaining({
        ticket: ref,
        state: "implementing",
        gates: [
          expect.objectContaining({
            gate: "frontier",
            fact: "blockers_closed",
            source: { system: "jira", ref },
            observed: { value: true },
          }),
          expect.objectContaining({ gate: "assignee", observed: { value: "test-owner" } }),
          expect.objectContaining({ gate: "status", observed: { value: "In Progress" } }),
          expect.objectContaining({ gate: "blockers", observed: { value: true } }),
          expect.objectContaining({
            gate: "claim",
            source: { system: "git", ref: expect.stringContaining("TEST-492") },
          }),
        ],
      }),
    ]);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a historical run with a version 1 configuration does not stop the supervisor",
  async () => {
    const { f, tick } = await supervised();
    const now = "2026-01-01T00:00:00.000Z";
    const ticket = ticketRefSchema.parse("jira:example:OLD:ticket:OLD-1");
    const run = runRefSchema.parse("interlock-run:historical");
    const store = new StateStore(f.state);
    try {
      store.saveRun({
        ref: run,
        ticket,
        host: adapterRefSchema.parse("t3"),
        harness: adapterRefSchema.parse("codex"),
        workspace: { path: "/historical" },
        capabilities: {},
        status: "claimed",
        createdAt: now,
        updatedAt: now,
      });
      store.database
        .query("INSERT INTO execution_configurations(run_ref,snapshot_json) VALUES(?,?)")
        .run(run, JSON.stringify({ version: 1, settings: { host: "t3" }, sources: {} }));
      const attached = transitionLane(
        createLane({ id: laneRefSchema.parse("interlock-lane:historical"), ticket }, now),
        { type: "attach", run, claim: claimRefSchema.parse("interlock-claim:historical") },
        now,
      );
      if (attached.refusal) throw new Error(attached.refusal.message);
      store.saveLane(attached.lane);
    } finally {
      store.close();
    }

    expect(await tick()).toMatchObject({ launched: [{ ticket: ref }], failures: [] });
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "parallelism counts launched lanes before they attach",
  async () => {
    const { f, starts } = await supervised();
    f.jira.relatedIssues.push({
      ...structuredClone(f.jira.issue),
      key: "TEST-493",
      fields: { ...structuredClone(f.jira.issue.fields), customfield_rank: "0|b:" },
    });
    const run = (parallelism: string) =>
      createApplication(f.services).run.execute({
        project: `TEST-470=${f.remote.alice}`,
        once: true,
        parallelism,
        state: f.state,
      });

    expect(await run("1")).toMatchObject({ launched: [{ ticket: ref }] });
    expect(await run("1")).toMatchObject({ launched: [] });
    expect(starts()).toHaveLength(1);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "the recorded launch session is followed through a rename, and a lost one needs attention after repeated misses",
  async () => {
    const { f, tick, t3 } = await supervised();
    await tick();
    if (!t3.bound) throw new Error("launch bound no thread");
    t3.bound.title = "🔨 TEST-492 — renamed by a person";
    t3.listed = false;
    expect(await tick()).toMatchObject({ attention: [], failures: [], held: [] });

    t3.bound = undefined;
    const misses = [await tick(), await tick()];
    expect(misses.map((report) => report.attention)).toEqual([[], []]);
    expect(misses.map((report) => report.failures[0]?.step)).toEqual(["session", "session"]);
    const report = await tick();

    const lane = inspect(f, (store) => store.laneForTicket(ref));
    if (!lane) throw new Error("pickup recorded no lane");
    expect(report.attention).toEqual([{ lane: lane.id, reason: "session_unreachable" }]);
    expect(lane).toMatchObject({ state: "attention", previousState: "implementing" });
    expect(report.launched).toEqual([]);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "an unattached lane whose launch needs recovery is shown as needing attention",
  async () => {
    const { f, tick } = await supervised();
    await tick();
    const store = new StateStore(f.state);
    const run = store.listRuns()[0];
    if (!run) throw new Error("pickup recorded no run");
    store.saveRun({ ...run, status: "recovery_required" });
    store.close();

    const report = await tick();

    expect(report.attention).toEqual([
      { lane: expect.stringMatching(/^interlock-lane:/), reason: "recovery_required" },
    ]);
    expect(report.launched).toEqual([]);
    const status = await createApplication(f.services).status.execute({ state: f.state });
    expect(status[0]).toMatchObject({ needsAttention: true, reason: "recovery_required" });
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a claim released by a person holds the lane even though the record keeps its claim ref",
  async () => {
    const { f, tick } = await supervised();
    await tick();
    const store = new StateStore(f.state);
    const run = store.listRuns()[0];
    const lane = store.laneForTicket(ref);
    if (!run || !lane) throw new Error("pickup recorded no lane");
    const claim = store.claimForRun(run.ref).ref;
    store.saveLane({ ...lane, state: "implementing", run: run.ref, claim });
    store.close();
    await lock(f).restore(ref, claim);
    expect((await lock(f).read(ref)).record).toMatchObject({ action: "release", claim });

    const report = await tick();

    expect(report.held).toEqual([{ lane: lane.id, ticket: ref, reason: "claim_changed" }]);
    expect(report).toMatchObject({ launched: [], resumed: [], attention: [] });
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a release written by the lane's own interrupted completion is not a human edit",
  async () => {
    const { f, tick } = await supervised();
    await tick();
    const store = new StateStore(f.state);
    const run = store.listRuns()[0];
    const lane = store.laneForTicket(ref);
    if (!run || !lane) throw new Error("pickup recorded no lane");
    const claim = store.claimForRun(run.ref).ref;
    store.saveLane({ ...lane, state: "implementing", run: run.ref, claim });
    store.recordStep(run.ref, "completion_release_pending", { claim });
    store.close();
    await lock(f).restore(ref, claim);

    const report = await tick();

    expect(report).toMatchObject({ held: [], attention: [], failures: [] });
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "run --only never launches a frontier ticket outside the list",
  async () => {
    const { f, starts } = await supervised();
    const report = await createApplication(f.services).run.execute({
      project: `TEST-470=${f.remote.alice}`,
      once: true,
      only: "TEST-999",
      state: f.state,
    });
    expect(report).toMatchObject({ launched: [], failures: [] });
    expect(starts()).toHaveLength(0);
    const refused = await rejection(
      createApplication(f.services).run.execute({
        project: `TEST-470=${f.remote.alice}`,
        once: true,
        only: "TEST-999,nope",
        state: f.state,
      }),
    );
    expect(refused.message).toContain("--only needs comma-separated ticket keys, not nope");
  },
  GIT_TEST_TIMEOUT_MS,
);
