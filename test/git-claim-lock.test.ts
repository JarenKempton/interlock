import { afterEach, describe, expect, test } from "bun:test";
import {
  ABSENT_LOCK_VERSION,
  GitClaimLock,
  type GitClaimLockOptions,
  heldClaim,
} from "../src/adapters/claims/git-lock.ts";
import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
} from "../src/domain/contracts.ts";
import {
  actorRefSchema,
  claimRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../src/domain/identifiers.ts";
import {
  type GitRemoteFixture,
  git,
  gitRemoteFixture,
  ScriptedGit,
} from "./fixtures/git-remote.ts";

const ticket = ticketRefSchema.parse("jira:responsibid:JWB:ticket:JWB-900");
const ref = "refs/interlock/claims/JWB-900";
const alice = actorRefSchema.parse("alice");
const bob = actorRefSchema.parse("bob");
const now = { value: new Date("2026-10-22T00:00:00.000Z") };
const clock = { now: () => now.value };
const lease = "2026-10-22T00:15:00.000Z";

let fixtures: GitRemoteFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.dispose()));
  fixtures = [];
  now.value = new Date("2026-10-22T00:00:00.000Z");
});

async function setup() {
  const fixture = await gitRemoteFixture();
  fixtures.push(fixture);
  const lock = (repository: string, options: Partial<GitClaimLockOptions> = {}) =>
    new GitClaimLock({ repository, remote: fixture.remote, clock, ...options });
  return { fixture, alice: lock(fixture.alice), bob: lock(fixture.bob), lock };
}

function claimRequest(
  owner: typeof alice,
  id: string,
  expectedVersion: string = ABSENT_LOCK_VERSION,
): ClaimRequest {
  return {
    ticket,
    claim: claimRefSchema.parse(`interlock-claim:${id}`),
    run: runRefSchema.parse(`interlock-run:${id}`),
    owner,
    leaseExpiresAt: lease,
    expectedVersion,
  };
}

describe("Git remote claim lock", () => {
  test("concurrent claims leave exactly one winner and the loser gets a collision", async () => {
    for (let round = 0; round < 5; round += 1) {
      const { alice: first, bob: second } = await setup();
      const results = await Promise.allSettled([
        first.claim(claimRequest(alice, "a")),
        second.claim(claimRequest(bob, "b")),
      ]);
      const winners = results.filter((result) => result.status === "fulfilled");
      const losers = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toBeInstanceOf(ClaimCollisionError);
      const held = heldClaim(await first.read(ticket));
      expect(held?.owner).toBe(results[0]?.status === "fulfilled" ? alice : bob);
    }
  });

  test("the remote's old-value check rejects a writer whose observed tip went stale", async () => {
    const { fixture, alice: winner, lock } = await setup();
    const scripted = new ScriptedGit();
    const loser = lock(fixture.bob, { git: scripted });
    scripted.beforePush = () => winner.claim(claimRequest(alice, "a"));
    await expect(loser.claim(claimRequest(bob, "b"))).rejects.toBeInstanceOf(ClaimCollisionError);
    expect(scripted.calls.some((argv) => argv[1] === "push")).toBe(true);
    expect(heldClaim(await loser.read(ticket))?.owner).toBe(alice);
  });

  test("claim, renew, release and reclaim append fast-forward commits without forcing", async () => {
    const { fixture, lock } = await setup();
    const scripted = new ScriptedGit();
    const subject = lock(fixture.alice, { git: scripted });
    const claim = claimRequest(alice, "a");
    await subject.claim(claim);
    const claimed = await subject.read(ticket);
    expect(heldClaim(claimed)).toMatchObject({
      action: "claim",
      owner: alice,
      leaseExpiresAt: lease,
    });

    await expect(subject.claim(claimRequest(bob, "b", claimed.version))).rejects.toBeInstanceOf(
      ClaimCollisionError,
    );
    const renewed = "2026-10-22T00:30:00.000Z";
    await expect(
      subject.renew({ ...claim, leaseExpiresAt: renewed, expectedVersion: ABSENT_LOCK_VERSION }),
    ).rejects.toBeInstanceOf(ClaimCollisionError);
    await subject.renew({ ...claim, leaseExpiresAt: renewed, expectedVersion: claimed.version });
    const afterRenew = await subject.read(ticket);
    expect(heldClaim(afterRenew)?.leaseExpiresAt).toBe(renewed);

    now.value = new Date("2026-10-22T00:20:00.000Z");
    const reclaim = {
      ...claimRequest(bob, "b", afterRenew.version),
      staleClaim: claim.claim,
      authorizedBy: bob,
      leaseExpiresAt: "2026-10-22T00:45:00.000Z",
      originalSnapshot: { version: ABSENT_LOCK_VERSION, payload: null },
    };
    await expect(subject.reclaim(reclaim)).rejects.toThrow("Claim lock lease is not stale");
    now.value = new Date("2026-10-22T00:31:00.000Z");
    await subject.reclaim(reclaim);
    const reclaimed = await subject.read(ticket);
    expect(heldClaim(reclaimed)).toMatchObject({ owner: bob, supersedes: claim.claim });

    const release = {
      ticket,
      claim: reclaim.claim,
      originalSnapshot: reclaim.originalSnapshot,
      expectedVersion: reclaimed.version,
      authorizedBy: alice,
    };
    await expect(subject.release(release)).rejects.toBeInstanceOf(ClaimCollisionError);
    await subject.release({ ...release, authorizedBy: bob });
    const released = await subject.read(ticket);
    expect(released.record?.action).toBe("release");
    expect(heldClaim(released)).toBeUndefined();

    const next = lock(fixture.bob);
    await next.claim({
      ...claimRequest(alice, "c", released.version),
      leaseExpiresAt: "2026-10-22T01:00:00.000Z",
    });
    expect(heldClaim(await next.read(ticket))?.claim).toBe(
      claimRefSchema.parse("interlock-claim:c"),
    );
    expect(await git(["rev-list", "--count", ref], fixture.remote)).toBe("5");

    const pushes = scripted.calls.filter((argv) => argv[1] === "push");
    expect(pushes).toHaveLength(4);
    for (const push of pushes) {
      expect(push.some((arg) => arg.startsWith("-f") || arg.startsWith("--force"))).toBe(false);
      expect(push.at(-1)?.startsWith("+")).toBe(false);
      expect(push.at(-1)?.endsWith(`:${ref}`)).toBe(true);
    }
    expect(scripted.calls.some((argv) => argv.includes("--delete"))).toBe(false);
  });

  test("compensation releases only a lock this claim still holds", async () => {
    const { alice: subject, bob: other } = await setup();
    const mine = claimRequest(alice, "a");
    await subject.restore(ticket, mine.claim);
    expect((await subject.read(ticket)).version).toBe(ABSENT_LOCK_VERSION);
    await subject.claim(mine);
    await subject.restore(ticket, mine.claim);
    const released = await subject.read(ticket);
    expect(heldClaim(released)).toBeUndefined();
    await other.claim(claimRequest(bob, "b", released.version));
    const held = await other.read(ticket);
    await subject.restore(ticket, mine.claim);
    expect((await other.read(ticket)).version).toBe(held.version);
  });

  test("a dropped connection after the remote applied the push resolves to success", async () => {
    const { fixture, lock } = await setup();
    const scripted = new ScriptedGit();
    scripted.push = async (run) => {
      await run();
      return { exitCode: 128, stdout: "", stderr: "fatal: the remote end hung up unexpectedly" };
    };
    const subject = lock(fixture.alice, { git: scripted });
    await subject.claim(claimRequest(alice, "a"));
    expect(heldClaim(await subject.read(ticket))?.owner).toBe(alice);
  });

  test("an unapplied push with no definite rejection stays ambiguous", async () => {
    const { fixture, lock } = await setup();
    const scripted = new ScriptedGit();
    scripted.push = async () => ({ exitCode: 128, stdout: "", stderr: "fatal: timed out" });
    const subject = lock(fixture.alice, { git: scripted });
    await expect(subject.claim(claimRequest(alice, "a"))).rejects.toBeInstanceOf(
      AmbiguousTrackerResultError,
    );
  });

  test("an unreadable remote after pushing stays ambiguous even if the write landed", async () => {
    const { fixture, lock } = await setup();
    const scripted = new ScriptedGit();
    scripted.lsRemoteFailuresAfterPush = 1;
    const subject = lock(fixture.alice, { git: scripted });
    await expect(subject.claim(claimRequest(alice, "a"))).rejects.toBeInstanceOf(
      AmbiguousTrackerResultError,
    );
    expect(heldClaim(await subject.read(ticket))?.owner).toBe(alice);
  });

  test("a definite rejection with the tip unchanged is a failure, not a collision", async () => {
    const { fixture, lock } = await setup();
    const scripted = new ScriptedGit();
    scripted.push = async () => ({
      exitCode: 1,
      stdout: `To remote\n!\tabc:${ref}\t[remote rejected] (namespace denied)\nDone\n`,
      stderr: "",
    });
    const subject = lock(fixture.alice, { git: scripted });
    const failure = subject.claim(claimRequest(alice, "a"));
    await expect(failure).rejects.toThrow("[remote rejected] (namespace denied)");
    await expect(failure).rejects.not.toBeInstanceOf(ClaimCollisionError);
  });

  test("the documented fallback namespace uses an ordinary branch ref", async () => {
    const { fixture, lock } = await setup();
    const subject = lock(fixture.alice, { namespace: "refs/heads/interlock/claims" });
    expect(subject.ref(ticket)).toBe("refs/heads/interlock/claims/JWB-900");
    await subject.claim(claimRequest(alice, "a"));
    expect(
      await git(["rev-list", "--count", "refs/heads/interlock/claims/JWB-900"], fixture.remote),
    ).toBe("1");
  });

  test("rejects unsafe keys, past leases and records for another ticket", async () => {
    const { fixture, alice: subject, lock } = await setup();
    expect(() => subject.ref(ticketRefSchema.parse("jira:responsibid:JWB:ticket:a..b"))).toThrow(
      "Ticket key cannot name a claim lock ref",
    );
    expect(() => lock(fixture.alice, { namespace: "refs/interlock/" })).toThrow(
      "Invalid claim lock namespace",
    );
    await expect(
      subject.claim({ ...claimRequest(alice, "a"), leaseExpiresAt: "2026-10-21T00:00:00.000Z" }),
    ).rejects.toThrow("Claim lease must expire in the future");
    const other = ticketRefSchema.parse("jira:other:JWB:ticket:JWB-900");
    await subject.claim({ ...claimRequest(alice, "a"), ticket: other });
    await expect(subject.read(ticket)).rejects.toThrow(`belongs to ${other}`);
  });
});
