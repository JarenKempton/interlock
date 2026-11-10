import { expect, setDefaultTimeout, test } from "bun:test";
import { run as runCli } from "../../src/cli.ts";
import { GIT_TEST_TIMEOUT_MS } from "../fixtures/git-remote.ts";
import { laneCompleteFixtures, prUrl, runRef } from "../fixtures/lane-complete.ts";

setDefaultTimeout(GIT_TEST_TIMEOUT_MS);
const { mergedLane, changeStore } = laneCompleteFixtures();

async function status(statePath: string, json: boolean) {
  const output: string[] = [];
  const code = await runCli(["status", "--state", statePath, ...(json ? ["--json"] : [])], (text) =>
    output.push(text),
  );
  return { code, text: output.join("\n") };
}

test("status shows each lane's gate evidence with fact, source and observed value", async () => {
  const lane = await mergedLane();
  changeStore(lane, (store) =>
    store.recordStep(runRef, "supervisor_gate", {
      kind: "gate",
      evidence: {
        gate: "assignee",
        fact: "ticket_assigned_to_claim_owner",
        source: { system: "jira", ref: "jira:x:JWB:ticket:JWB-909" },
        observed: { value: "owner" },
        observedAt: "2026-11-10T00:00:00.000Z",
      },
    }),
  );
  const before = JSON.parse((await status(lane.statePath, true)).text);
  expect(before).toEqual([
    expect.objectContaining({
      state: "approved",
      needsAttention: false,
      artifact: prUrl,
      gates: [
        expect.objectContaining({ gate: "test", observed: { value: lane.repo.head } }),
        expect.objectContaining({
          gate: "assignee",
          source: { system: "jira", ref: "jira:x:JWB:ticket:JWB-909" },
          observed: { value: "owner" },
        }),
      ],
    }),
  ]);

  expect((await lane.complete()).code).toBe(0);
  const after = JSON.parse((await status(lane.statePath, true)).text);
  expect(after[0].state).toBe("done");
  expect(after[0].gates.map((gate: { gate: string }) => gate.gate)).toEqual([
    "test",
    "assignee",
    "merge",
    "tracker_done",
    "mirror_removed",
    "claim_released",
  ]);
  expect((await status(lane.statePath, false)).text).toContain(
    `merge: pull_request_merged = ${lane.repo.merge} (github ${prUrl}`,
  );
});

test("status flags a lane in attention with its reason", async () => {
  const lane = await mergedLane();
  changeStore(lane, (store) =>
    store.saveLane({
      ...store.lane(lane.id),
      state: "attention",
      previousState: "approved",
      attentionReason: "stalled",
    }),
  );
  const { text } = await status(lane.statePath, false);
  expect(text.split("\n")[0]).toBe(
    `jira:x:JWB:ticket:JWB-909  attention  needs attention: stalled  ${prUrl}`,
  );
});
