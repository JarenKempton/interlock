import { expect, test } from "bun:test";
import { claimLockConformance } from "../../src/conformance/claim-lock.ts";
import { fakeTrackerFixture } from "../../src/conformance/fake-tracker.ts";
import { runConformance } from "../../src/conformance/runner.ts";
import { trackerConformance } from "../../src/conformance/tracker.ts";
import { fakeLockFixture } from "../fixtures/conformance/lock.ts";

test("fake trackers of both mirror tiers and the fake claim lock pass conformance", async () => {
  const report = await runConformance([
    ...trackerConformance(async () => fakeTrackerFixture("structured")),
    ...trackerConformance(async () => fakeTrackerFixture("assignee_only")),
    ...claimLockConformance(async () => fakeLockFixture()),
  ]);
  expect(report.results.filter((result) => !result.ok)).toEqual([]);
  expect(report.results.length).toBe(18);
});
