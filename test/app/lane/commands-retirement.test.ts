import { expect, setDefaultTimeout, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { GitClaimLock } from "../../../src/adapters/git/claim-lock.ts";
import { BunGitCommandExecutor } from "../../../src/adapters/git/workspace.ts";
import { normalizeClaimHome } from "../../../src/domain/claim/home.ts";
import {
  actorRefSchema,
  claimRefSchema,
  laneRefSchema,
  runRefSchema,
} from "../../../src/domain/refs/identifiers.ts";
import { GIT_TEST_TIMEOUT_MS } from "../../fixtures/git/remote.ts";
import {
  branch,
  git,
  laneCompleteFixtures,
  runRef,
  ticketRef,
} from "../../fixtures/lane/complete.ts";

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

test("MCP completion releases the claim with history intact and leaves submission reservations unchanged", async () => {
  const lane = await mergedLane({ mcp: true, squash: true });
  const legacyRef = `refs/interlock/submissions/v1/${"a".repeat(64)}`;
  git(["push", lane.repo.origin, `${lane.repo.head}:${legacyRef}`], lane.repo.main);
  const before = git(["ls-remote", lane.repo.origin, legacyRef], lane.repo.main);
  const claimBefore = await lockFor(lane).read(ticketRef);
  expect(before).not.toBe("");
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
  expect(git(["ls-remote", lane.repo.origin, legacyRef], lane.repo.main)).toBe(before);
  const released = await lockFor(lane).read(ticketRef);
  expect(released.record).toMatchObject({
    ...claimBefore.record,
    action: "release",
    authorizedBy: "owner",
  });
  expect(git(["rev-parse", `${released.version}^`], lane.repo.main)).toBe(claimBefore.version);
  expect(lane.tracker.removals).toBe(1);
  changeStore(lane, (store) => {
    expect(store.run(runRef).status).toBe("released");
    expect(store.claimForRun(runRef).status).toBe("released");
    expect(store.steps(runRef).map((step) => step.state)).toEqual(
      expect.arrayContaining([
        "completion_mirror_pending",
        "completion_mirror_removed",
        "completion_release_pending",
        "completion_released",
        "lane_completed",
      ]),
    );
  });
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

test("legacy retirement fence releases by fresh version and preserves its history", async () => {
  const lane = await mergedLane();
  const lock = lockFor(lane);
  const before = await lock.read(ticketRef);
  const record = { ...before.record, claim: "interlock-claim:retirement-old" };
  const fenced = git(
    [
      "commit-tree",
      git(["mktree"], lane.repo.main),
      "-p",
      before.version,
      "-m",
      "legacy retirement",
      "-m",
      JSON.stringify(record),
    ],
    lane.repo.main,
  );
  git(["push", lane.repo.origin, `${fenced}:${await lock.ref(ticketRef)}`], lane.repo.main);
  changeStore(lane, (store) =>
    store.saveClaim({ ...store.claimForRun(runRef), currentVersion: before.version }),
  );
  expect((await lane.complete()).code).toBe(0);
  const after = await lock.read(ticketRef);
  expect(after.record).toMatchObject({ action: "release", claim: record.claim, run: runRef });
  expect(git(["rev-parse", `${after.version}^`], lane.repo.main)).toBe(fenced);
});

test("mirror removal failure retains ownership and retries from recovery", async () => {
  const lane = await mergedLane();
  const before = await lockFor(lane).read(ticketRef);
  const remove = lane.tracker.removeMirror.bind(lane.tracker);
  lane.tracker.removeMirror = async () => {
    throw new Error("readback failed");
  };
  expect((await lane.complete()).result).toMatchObject({ refusal: { code: "recovery_required" } });
  expect(await lockFor(lane).read(ticketRef)).toEqual(before);
  changeStore(lane, (store) => expect(store.run(runRef).status).toBe("recovery_required"));
  lane.tracker.removeMirror = remove;
  expect((await lane.complete()).code).toBe(0);
  expect(lane.tracker.transitions).toEqual(["Done"]);
});

test("accepted release with lost readback resumes without appending a second release", async () => {
  const commands = new BunGitCommandExecutor();
  let loseRead = false;
  let pushes = 0;
  const lane = await mergedLane({
    git: {
      async run(argv, cwd) {
        if (loseRead && argv[1] === "ls-remote" && argv[2] !== "--get-url") {
          loseRead = false;
          throw new Error("lost release readback");
        }
        const result = await commands.run(argv, cwd);
        if (argv[1] === "push") {
          pushes += 1;
          loseRead = true;
        }
        return result;
      },
    },
  });
  expect((await lane.complete()).result).toMatchObject({ refusal: { code: "recovery_required" } });
  const released = await lockFor(lane).read(ticketRef);
  expect(released.record?.action).toBe("release");
  expect((await lane.complete()).code).toBe(0);
  expect(await lockFor(lane).read(ticketRef)).toEqual(released);
  expect(pushes).toBe(1);
});

test("replacement installed during mirror removal is never released", async () => {
  const lane = await mergedLane();
  lane.tracker.removeMirror = async () => {
    await release(lane);
    const lock = lockFor(lane);
    await lock.claim({
      claim: claimRefSchema.parse("interlock-claim:replacement"),
      run: runRef,
      owner: actorRefSchema.parse("owner"),
      ticket: ticketRef,
      leaseExpiresAt: "2099-01-01T00:00:00Z",
      expectedVersion: (await lock.read(ticketRef)).version,
    });
  };
  expect((await lane.complete()).result).toMatchObject({ refusal: { code: "recovery_required" } });
  expect((await lockFor(lane).read(ticketRef)).record).toMatchObject({
    action: "claim",
    claim: "interlock-claim:replacement",
  });
});

test("an expired lease does not release ownership or prevent completion", async () => {
  const lane = await mergedLane({ leaseExpiresAt: "2020-01-02T00:00:00.000Z" });
  expect((await lane.complete()).result).toMatchObject({ ok: true, value: { state: "done" } });
  lane.intact();
});
