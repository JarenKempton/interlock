import { expect, setDefaultTimeout, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { GitClaimLock } from "../src/adapters/claims/git-lock.ts";
import { submissionRef } from "../src/adapters/submissions/git.ts";
import { BunGitCommandExecutor } from "../src/adapters/workspaces/git.ts";
import { normalizeClaimHome } from "../src/domain/claim-home.ts";
import {
  actorRefSchema,
  claimRefSchema,
  laneRefSchema,
  runRefSchema,
} from "../src/domain/identifiers.ts";
import { GIT_TEST_TIMEOUT_MS } from "./fixtures/git-remote.ts";
import { branch, git, laneCompleteFixtures, runRef, ticketRef } from "./fixtures/lane-complete.ts";

setDefaultTimeout(GIT_TEST_TIMEOUT_MS);
const { mergedLane, changeStore } = laneCompleteFixtures();
type Fixture = Awaited<ReturnType<typeof mergedLane>>;

function lockFor(lane: Fixture) {
  return new GitClaimLock({
    repository: lane.repo.main,
    home: normalizeClaimHome(lane.repo.origin),
    git: new BunGitCommandExecutor(),
  });
}

async function release(lane: Fixture) {
  const lock = lockFor(lane);
  await lock.release({
    claim: claimRefSchema.parse("interlock-claim:complete"),
    ticket: ticketRef,
    claimedOwner: actorRefSchema.parse("owner"),
    authorizedBy: actorRefSchema.parse("owner"),
    expectedVersion: (await lock.read(ticketRef)).version,
    originalSnapshot: { version: "1", payload: null },
  });
}

test("MCP completion leaves the shared remote claim and submission reservation unchanged", async () => {
  const lane = await mergedLane({ mcp: true, squash: true });
  const identity = {
    lane: lane.id,
    run: runRef,
    claim: claimRefSchema.parse("interlock-claim:complete"),
    ticket: ticketRef,
    repository: "github.com/o/r",
    branch,
  };
  const before = git(["ls-remote", lane.repo.origin, submissionRef(identity)], lane.repo.main);
  const claimBefore = await lockFor(lane).read(ticketRef);
  expect(before).not.toBe("");
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
  expect(git(["ls-remote", lane.repo.origin, submissionRef(identity)], lane.repo.main)).toBe(
    before,
  );
  expect(await lockFor(lane).read(ticketRef)).toEqual(claimBefore);
  lane.intact();
});

test("a released remote claim refuses even when local run and claim still look active", async () => {
  const lane = await mergedLane();
  await release(lane);
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "claim_collision" },
  });
  expect(lane.tracker.transitions).toEqual([]);
  lane.intact();
});

for (const field of ["claim", "run", "owner"] as const) {
  test(`replacement remote ${field} during merge proof fetch blocks the first tracker write`, async () => {
    let lane: Fixture;
    lane = await mergedLane({
      onProof: async () => {
        await release(lane);
        const lock = lockFor(lane);
        const identity = {
          claim: claimRefSchema.parse("interlock-claim:complete"),
          run: runRef,
          owner: actorRefSchema.parse("owner"),
        };
        await lock.claim({
          ...identity,
          [field]:
            field === "claim"
              ? claimRefSchema.parse("interlock-claim:new")
              : field === "run"
                ? runRefSchema.parse("interlock-run:new")
                : actorRefSchema.parse("new"),
          ticket: ticketRef,
          leaseExpiresAt: "2099-01-01T00:00:00Z",
          expectedVersion: (await lock.read(ticketRef)).version,
        });
      },
    });
    expect((await lane.complete()).result).toMatchObject({
      ok: false,
      refusal: { code: "claim_collision" },
    });
    expect(lane.tracker.transitions).toEqual([]);
    lane.intact();
  });
}

test("every interrupted completion retry checks remote ownership before tracker writes", async () => {
  const lane = await mergedLane();
  lane.tracker.onTransition = () => {};
  expect((await lane.complete()).result.ok).toBe(false);
  await release(lane);
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "claim_collision" },
  });
  expect(lane.tracker.transitions).toEqual(["Done"]);
});

test("release during the tracker pre-read is checked again before the Done mutation", async () => {
  const lane = await mergedLane();
  const read = lane.tracker.read.bind(lane.tracker);
  lane.tracker.read = async (ref) => {
    await release(lane);
    return read(ref);
  };
  expect((await lane.complete()).result).toMatchObject({
    ok: false,
    refusal: { code: "claim_collision" },
  });
  expect(lane.tracker.transitions).toEqual([]);
});

test("symlink aliases of another lane's workspace refuse completion", async () => {
  const lane = await mergedLane();
  const alias = join(lane.repo.root, "alias");
  symlinkSync(lane.repo.lane, alias, "junction");
  changeStore(lane, (store) => {
    const otherRun = runRefSchema.parse("interlock-run:other");
    store.saveRun({ ...store.run(runRef), ref: otherRun, workspace: { path: alias, branch } });
    store.saveLane({
      ...store.lane(lane.id),
      id: laneRefSchema.parse("interlock-lane:other"),
      run: otherRun,
      claim: claimRefSchema.parse("interlock-claim:other"),
    });
  });
  expect((await lane.complete({ lane: lane.id })).result.ok).toBe(false);
  expect(lane.tracker.transitions).toEqual([]);
  lane.intact();
});

test("an expired lease does not release ownership or prevent completion", async () => {
  const lane = await mergedLane({ leaseExpiresAt: "2020-01-02T00:00:00.000Z" });
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
  lane.intact();
});
