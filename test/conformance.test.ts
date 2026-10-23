import { expect, test } from "bun:test";
import { claimLockConformance } from "../src/conformance/claim-lock.ts";
import { runConformance } from "../src/conformance/runner.ts";
import { trackerConformance } from "../src/conformance/tracker.ts";
import { fakeLockFixture } from "./fixtures/portable-lock.ts";
import { fakeTrackerFixture } from "./fixtures/portable-tracker.ts";

test("fake tracker and claim lock pass conformance", async () => {
  const report = await runConformance([
    ...trackerConformance(async () => fakeTrackerFixture()),
    ...claimLockConformance(async () => fakeLockFixture()),
  ]);
  expect(report.results.filter((result) => !result.ok)).toEqual([]);
  expect(report.results.length).toBe(13);
});
