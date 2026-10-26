import { afterEach, describe, expect, test } from "bun:test";
import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  checkedGit,
  GIT_TEST_TIMEOUT_MS,
  type GitRemoteFixture,
  gitRemoteFixture,
  ScriptedGit,
} from "./fixtures/git-remote.ts";

const ticket = ticketRefSchema.parse("jira:responsibid:JWB:ticket:JWB-900");
const ref = "refs/interlock/claims/JWB-900";
const alice = actorRefSchema.parse("alice");
const bob = actorRefSchema.parse("bob");
const lease = "2026-10-22T00:15:00.000Z";

let fixtures: GitRemoteFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.dispose()));
  fixtures = [];
});

async function setup() {
  const fixture = await gitRemoteFixture();
  fixtures.push(fixture);
  const lock = (repository: string, options: Partial<GitClaimLockOptions> = {}) =>
    new GitClaimLock({
      repository,
      remote: fixture.remote,
      clock: fixture.clock,
      git: fixture.git,
      ...options,
    });
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

test.each(["landed", "competing"])(
  "an uncertain push blocks restoration until its outcome is resolved: %s",
  async (outcome) => {
    const { fixture, lock, bob: competitor } = await setup();
    const git = new ScriptedGit(fixture.git);
    const subject = lock(fixture.alice, { git });
    let finishPush: (() => Promise<unknown>) | undefined;
    git.push = async (run) => {
      finishPush = run;
      return { exitCode: 128, stdout: "", stderr: "connection lost" };
    };
    const claim = claimRequest(alice, "delayed");
    await expect(subject.claim(claim)).rejects.toBeInstanceOf(AmbiguousTrackerResultError);
    await expect(subject.read(ticket)).rejects.toBeInstanceOf(AmbiguousTrackerResultError);
    await expect(subject.restore(ticket, claim.claim)).rejects.toBeInstanceOf(
      AmbiguousTrackerResultError,
    );
    if (!finishPush) throw new Error("Expected a pending push");
    if (outcome === "competing") await competitor.claim(claimRequest(bob, "winner"));
    await finishPush();
    await subject.restore(ticket, claim.claim);
    const state = await subject.read(ticket);
    if (outcome === "landed")
      expect(state.record).toMatchObject({ action: "release", claim: claim.claim });
    else expect(heldClaim(state)?.claim).toBe(claimRefSchema.parse("interlock-claim:winner"));
  },
  GIT_TEST_TIMEOUT_MS,
);

describe("Git remote claim lock", () => {
  test(
    "concurrent claims leave exactly one winner and the loser gets a collision",
    async () => {
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
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "the remote's old-value check rejects a writer whose observed tip went stale",
    async () => {
      const { fixture, alice: winner, lock } = await setup();
      const scripted = new ScriptedGit(fixture.git);
      const loser = lock(fixture.bob, { git: scripted });
      scripted.beforePush = () => winner.claim(claimRequest(alice, "a"));
      await expect(loser.claim(claimRequest(bob, "b"))).rejects.toBeInstanceOf(ClaimCollisionError);
      expect(scripted.calls.some((argv) => argv[1] === "push")).toBe(true);
      expect(heldClaim(await loser.read(ticket))?.owner).toBe(alice);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "claim and release append fast-forward commits without forcing",
    async () => {
      const { fixture, lock } = await setup();
      const scripted = new ScriptedGit(fixture.git);
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
      const release = {
        ticket,
        claim: claim.claim,
        originalSnapshot: { version: ABSENT_LOCK_VERSION, payload: null },
        expectedVersion: claimed.version,
        authorizedBy: bob,
      };
      await expect(subject.release(release)).rejects.toBeInstanceOf(ClaimCollisionError);
      await subject.release({ ...release, authorizedBy: alice });
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
      expect(await checkedGit(fixture.git, ["rev-list", "--count", ref], fixture.remote)).toBe("3");

      const pushes = scripted.calls.filter((argv) => argv[1] === "push");
      expect(pushes).toHaveLength(2);
      for (const push of pushes) {
        expect(push.some((arg) => arg.startsWith("-f") || arg.startsWith("--force"))).toBe(false);
        expect(push.at(-1)?.startsWith("+")).toBe(false);
        expect(push.at(-1)?.endsWith(`:${ref}`)).toBe(true);
      }
      expect(scripted.calls.some((argv) => argv.includes("--delete"))).toBe(false);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "compensation releases only a lock this claim still holds",
    async () => {
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
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test.each(["return", "throw"])(
    "a dropped connection after the remote applied the push resolves to success: %s",
    async (outcome) => {
      const { fixture, lock } = await setup();
      const scripted = new ScriptedGit(fixture.git);
      scripted.push = async (run) => {
        await run();
        if (outcome === "throw") throw new Error("connection lost");
        return { exitCode: 128, stdout: "", stderr: "fatal: the remote end hung up unexpectedly" };
      };
      const subject = lock(fixture.alice, { git: scripted });
      await subject.claim(claimRequest(alice, "a"));
      expect(heldClaim(await subject.read(ticket))?.owner).toBe(alice);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "an unapplied push with no definite rejection stays ambiguous",
    async () => {
      const { fixture, lock } = await setup();
      const scripted = new ScriptedGit(fixture.git);
      scripted.push = async () => ({ exitCode: 128, stdout: "", stderr: "fatal: timed out" });
      const subject = lock(fixture.alice, { git: scripted });
      await expect(subject.claim(claimRequest(alice, "a"))).rejects.toBeInstanceOf(
        AmbiguousTrackerResultError,
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "an unreadable remote after pushing stays ambiguous even if the write landed",
    async () => {
      const { fixture, lock } = await setup();
      const scripted = new ScriptedGit(fixture.git);
      scripted.lsRemoteFailuresAfterPush = 1;
      const subject = lock(fixture.alice, { git: scripted });
      await expect(subject.claim(claimRequest(alice, "a"))).rejects.toBeInstanceOf(
        AmbiguousTrackerResultError,
      );
      expect(heldClaim(await subject.read(ticket))?.owner).toBe(alice);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "a definite rejection with the tip unchanged is a failure, not a collision",
    async () => {
      const { fixture, lock } = await setup();
      const scripted = new ScriptedGit(fixture.git);
      scripted.push = async () => ({
        exitCode: 1,
        stdout: `To remote\n!\tabc:${ref}\t[remote rejected] (namespace denied)\nDone\n`,
        stderr: "",
      });
      const subject = lock(fixture.alice, { git: scripted });
      const failure = subject.claim(claimRequest(alice, "a"));
      await expect(failure).rejects.toThrow("[remote rejected] (namespace denied)");
      await expect(failure).rejects.not.toBeInstanceOf(ClaimCollisionError);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "lock commits carry the empty tree and name the claimant as author",
    async () => {
      const { fixture, alice: first, bob: second } = await setup();
      await first.claim(claimRequest(alice, "a"));
      const claimed = await first.read(ticket);
      await first.release({
        ticket,
        claim: claimRefSchema.parse("interlock-claim:a"),
        originalSnapshot: { version: ABSENT_LOCK_VERSION, payload: null },
        expectedVersion: claimed.version,
        authorizedBy: alice,
      });
      await second.claim(claimRequest(bob, "b", (await second.read(ticket)).version));
      expect(
        await checkedGit(fixture.git, ["log", "--format=%an %ae %cn %T", ref], fixture.remote),
      ).toBe(
        [
          "bob interlock@invalid bob 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
          "alice interlock@invalid alice 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
          "alice interlock@invalid alice 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        ].join("\n"),
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "a failing pre-push hook blocks ordinary pushes and the claim lock",
    async () => {
      const { fixture, alice: subject } = await setup();
      const hook = join(fixture.alice, ".git", "hooks", "pre-push");
      await writeFile(hook, "#!/bin/sh\necho 'pre-push hook: blocked' >&2\nexit 1\n");
      await chmod(hook, 0o755);
      const commit = await checkedGit(
        fixture.git,
        [
          "-c",
          "user.name=alice",
          "-c",
          "user.email=alice@invalid",
          "commit-tree",
          await checkedGit(fixture.git, ["mktree"], fixture.alice),
          "-m",
          "ordinary",
        ],
        fixture.alice,
      );
      const ordinary = await fixture.git.run(
        ["git", "push", fixture.remote, `${commit}:refs/heads/ordinary`],
        fixture.alice,
      );
      expect(ordinary.exitCode).not.toBe(0);
      expect(ordinary.stderr).toContain("pre-push hook: blocked");
      expect(await checkedGit(fixture.git, ["ls-remote", fixture.remote], fixture.alice)).toBe("");

      await expect(subject.claim(claimRequest(alice, "a"))).rejects.toBeInstanceOf(
        AmbiguousTrackerResultError,
      );
      await expect(subject.read(ticket)).rejects.toBeInstanceOf(AmbiguousTrackerResultError);
      expect(await checkedGit(fixture.git, ["ls-remote", fixture.remote, ref], fixture.alice)).toBe(
        "",
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test("no production push skips client hooks", async () => {
    const flag = ["--no", "verify"].join("-");
    const root = join(import.meta.dir, "..", "src");
    const files = await readdir(root, { recursive: true });
    const callers: string[] = [];
    for (const file of files.filter((name) => name.endsWith(".ts")).toSorted()) {
      const occurrences = (await readFile(join(root, file), "utf8")).split(flag).length - 1;
      for (let index = 0; index < occurrences; index += 1) callers.push(file.replaceAll("\\", "/"));
    }
    expect(callers).toEqual([]);
  });

  test(
    "rejects unsafe keys, past leases and records for another ticket",
    async () => {
      const { alice: subject } = await setup();
      expect(await subject.ref(ticket)).toBe(ref);
      for (const key of ["a..b", "a/b", "a b", "x.lock", "a@{1}"])
        await expect(
          subject.ref(ticketRefSchema.parse(`jira:responsibid:JWB:ticket:${key}`)),
        ).rejects.toThrow("Ticket key cannot name a claim lock ref");
      await expect(
        subject.claim({ ...claimRequest(alice, "a"), leaseExpiresAt: "2026-10-21T00:00:00.000Z" }),
      ).rejects.toThrow("Claim lease must expire in the future");
      const other = ticketRefSchema.parse("jira:other:JWB:ticket:JWB-900");
      await subject.claim({ ...claimRequest(alice, "a"), ticket: other });
      await expect(subject.read(ticket)).rejects.toThrow(`belongs to ${other}`);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

test.each([
  "pushurl",
  "multiple-pushurls",
  "multiple-fetchurls",
  "push-rewrite",
  "literal-rewrite",
])(
  "claim refuses divergent or ambiguous effective destinations: %s",
  async (configuration) => {
    const { fixture, lock } = await setup();
    const other = join(fixture.alice, "other.git");
    await checkedGit(fixture.git, ["init", "--bare", "--quiet", other], fixture.alice);
    await checkedGit(fixture.git, ["remote", "add", "origin", fixture.remote], fixture.alice);
    if (configuration === "pushurl" || configuration === "multiple-pushurls") {
      if (configuration === "multiple-pushurls")
        await checkedGit(
          fixture.git,
          ["config", "--add", "remote.origin.pushurl", fixture.remote],
          fixture.alice,
        );
      await checkedGit(
        fixture.git,
        ["config", "--add", "remote.origin.pushurl", other],
        fixture.alice,
      );
    } else if (configuration === "multiple-fetchurls") {
      await checkedGit(fixture.git, ["config", "--add", "remote.origin.url", other], fixture.alice);
    } else {
      await checkedGit(
        fixture.git,
        ["config", `url.${other}.pushInsteadOf`, fixture.remote],
        fixture.alice,
      );
    }
    const subject = lock(fixture.alice, {
      remote: configuration === "literal-rewrite" ? fixture.remote : "origin",
    });
    await expect(subject.claim(claimRequest(alice, "redirected"))).rejects.toThrow();
    for (const remote of [fixture.remote, other])
      expect(await checkedGit(fixture.git, ["ls-remote", remote, ref], fixture.alice)).toBe("");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a matching explicit push URL permits verified claim and release",
  async () => {
    const { fixture, lock } = await setup();
    await checkedGit(fixture.git, ["remote", "add", "origin", fixture.remote], fixture.alice);
    await checkedGit(
      fixture.git,
      ["remote", "set-url", "--push", "origin", fixture.remote],
      fixture.alice,
    );
    const subject = lock(fixture.alice, { remote: "origin" });
    const claim = claimRequest(alice, "same-destination");
    await subject.claim(claim);
    expect(heldClaim(await subject.read(ticket))?.claim).toBe(claim.claim);
    await subject.restore(ticket, claim.claim);
    expect((await subject.read(ticket)).record?.action).toBe("release");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "command-scoped remote URLs cannot bypass destination verification",
  async () => {
    const { fixture, lock } = await setup();
    const other = join(fixture.alice, "other.git");
    await checkedGit(fixture.git, ["init", "--bare", "--quiet", other], fixture.alice);
    const subject = lock(fixture.alice, {
      remote: "ephemeral",
      git: {
        run(argv, cwd) {
          return fixture.git.run(
            [
              "git",
              "-c",
              `remote.ephemeral.url=${fixture.remote}`,
              "-c",
              `remote.ephemeral.pushurl=${other}`,
              ...argv.slice(1),
            ],
            cwd,
          );
        },
      },
    });
    await expect(subject.claim(claimRequest(alice, "scoped-remote"))).rejects.toThrow(
      "fetch destination cannot be verified",
    );
    for (const remote of [fixture.remote, other])
      expect(await checkedGit(fixture.git, ["ls-remote", remote, ref], fixture.alice)).toBe("");
  },
  GIT_TEST_TIMEOUT_MS,
);
