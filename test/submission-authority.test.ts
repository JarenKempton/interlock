import { expect, test } from "bun:test";
import { GitClaimLock } from "../src/adapters/claims/git-lock.ts";
import { GitSubmissionAuthority, submissionRef } from "../src/adapters/submissions/git.ts";
import type { GitCommandExecutor } from "../src/adapters/workspaces/git.ts";
import { normalizeClaimHome } from "../src/domain/claim-home.ts";
import { actorRefSchema, adapterRefSchema } from "../src/domain/identifiers.ts";
import type { Claim, Run } from "../src/domain/model.ts";
import { SubmissionRefusal, submissionIdentitySchema } from "../src/domain/submission.ts";
import { RecordedSubmissionAuthority } from "../src/execution/submission.ts";
import { checkedGit, gitRemoteFixture } from "./fixtures/git-remote.ts";

const identity = submissionIdentitySchema.parse({
  lane: "interlock-lane:a",
  run: "interlock-run:a",
  claim: "interlock-claim:a",
  ticket: "jira:example:W:ticket:JWB-878",
  repository: "github.com/o/r",
  branch: "feature/JWB-878",
});

test("two repositories sharing a remote grant exactly one create permit and persist ownership", async () => {
  const fixture = await gitRemoteFixture();
  const home = normalizeClaimHome(fixture.remote);
  try {
    const first = new GitSubmissionAuthority(home, fixture.git);
    const second = new GitSubmissionAuthority(home, fixture.git);
    const results = await Promise.all([
      first.reserve(identity, fixture.alice),
      second.reserve(identity, fixture.bob),
    ]);
    expect(results.filter((result) => result.mayCreate)).toHaveLength(1);
    expect(
      await new GitSubmissionAuthority(home, fixture.git).reserve(identity, fixture.bob),
    ).toEqual({ mayCreate: false });
    const record = await first.read(identity, fixture.alice);
    expect(record?.identity).toEqual(identity);
    for (const patch of [
      { branch: "other/JWB-878" },
      { repository: "github.com/other/repo" },
      { claim: "interlock-claim:b" as const },
      { run: "interlock-run:b" as const },
    ])
      await expect(second.reserve({ ...identity, ...patch }, fixture.bob)).rejects.toBeInstanceOf(
        SubmissionRefusal,
      );
    expect(
      (
        await checkedGit(
          fixture.git,
          ["ls-remote", home.url, submissionRef(identity)],
          fixture.alice,
        )
      ).split("\n"),
    ).toHaveLength(1);
  } finally {
    await fixture.dispose();
  }
});

test("ambiguous reservation push only authorizes create after exact readback", async () => {
  const fixture = await gitRemoteFixture();
  const home = normalizeClaimHome(fixture.remote);
  try {
    const git: GitCommandExecutor = {
      run: async (argv, cwd) => {
        const result = await fixture.git.run(argv, cwd);
        if (argv[1] === "push") throw new Error("lost push response");
        return result;
      },
    };
    expect(await new GitSubmissionAuthority(home, git).reserve(identity, fixture.alice)).toEqual({
      mayCreate: true,
    });
    expect(
      await new GitSubmissionAuthority(home, fixture.git).reserve(identity, fixture.bob),
    ).toEqual({ mayCreate: false });
  } finally {
    await fixture.dispose();
  }
});

test("unreadable post-push reservation is fail-closed across restart with no compensation deletion", async () => {
  const fixture = await gitRemoteFixture();
  const home = normalizeClaimHome(fixture.remote);
  let pushed = false;
  try {
    const git: GitCommandExecutor = {
      run: async (argv, cwd) => {
        if (pushed && argv[1] === "ls-remote" && !argv.includes("--get-url"))
          throw new Error("offline");
        const result = await fixture.git.run(argv, cwd);
        if (argv[1] === "push") pushed = true;
        return result;
      },
    };
    await expect(
      new GitSubmissionAuthority(home, git).reserve(identity, fixture.alice),
    ).rejects.toMatchObject({ code: "recovery_required" });
    expect(
      await new GitSubmissionAuthority(home, fixture.git).reserve(identity, fixture.bob),
    ).toEqual({ mayCreate: false });
    expect(
      await new GitSubmissionAuthority(home, fixture.git).read(identity, fixture.bob),
    ).toBeDefined();
  } finally {
    await fixture.dispose();
  }
});

test("rejected reservation grants no permit, and competing ownership is never overwritten", async () => {
  const fixture = await gitRemoteFixture();
  const home = normalizeClaimHome(fixture.remote);
  try {
    const denied: GitCommandExecutor = {
      run: async (argv, cwd) =>
        argv[1] === "push"
          ? { exitCode: 1, stdout: "", stderr: "denied" }
          : fixture.git.run(argv, cwd),
    };
    await expect(
      new GitSubmissionAuthority(home, denied).reserve(identity, fixture.alice),
    ).rejects.toMatchObject({ code: "recovery_required" });
    expect(
      await new GitSubmissionAuthority(home, fixture.git).read(identity, fixture.alice),
    ).toBeUndefined();
    const rival = { ...identity, lane: "interlock-lane:other" as const, branch: "other/JWB-878" };
    const results = await Promise.allSettled([
      new GitSubmissionAuthority(home, fixture.git).reserve(identity, fixture.alice),
      new GitSubmissionAuthority(home, fixture.git).reserve(rival, fixture.bob),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  } finally {
    await fixture.dispose();
  }
});

test("recorded authority requires matching active local and remote claim ownership", async () => {
  const fixture = await gitRemoteFixture();
  const home = normalizeClaimHome(fixture.remote);
  const ticket = identity.ticket;
  if (!ticket) throw new Error("fixture ticket missing");
  const run: Run = {
    ref: identity.run,
    ticket,
    harness: adapterRefSchema.parse("t3"),
    workspace: { path: fixture.alice, branch: identity.branch },
    capabilities: {},
    status: "claimed",
    createdAt: "",
    updatedAt: "",
  };
  const claim: Claim = {
    ref: identity.claim,
    ticket,
    run: identity.run,
    humanOwner: actorRefSchema.parse("account"),
    previousState: { version: "1", payload: null },
    status: "active",
    claimedAt: "",
    leaseExpiresAt: "2099-01-01T00:00:00Z",
    claimHome: home.identity,
    claimHomeUrl: home.url,
  };
  const store = { run: () => run, claim: () => claim };
  try {
    const authority = new RecordedSubmissionAuthority(store, fixture.git);
    await expect(authority.reserve(identity, fixture.alice)).rejects.toMatchObject({
      code: "claim_collision",
    });
    const lock = new GitClaimLock({ repository: fixture.alice, home, git: fixture.git });
    await lock.claim({
      ticket,
      claim: identity.claim,
      run: identity.run,
      owner: claim.humanOwner,
      leaseExpiresAt: claim.leaseExpiresAt,
      expectedVersion: "absent",
    });
    expect(await authority.reserve(identity, fixture.alice)).toEqual({ mayCreate: true });
    run.status = "released";
    await expect(authority.reserve(identity, fixture.alice)).rejects.toMatchObject({
      code: "claim_collision",
    });
    run.status = "claimed";
    const state = await lock.read(ticket);
    await lock.release({
      ticket,
      claim: identity.claim,
      expectedVersion: state.version,
      authorizedBy: claim.humanOwner,
      originalSnapshot: claim.previousState,
    });
    await expect(authority.reserve(identity, fixture.alice)).rejects.toMatchObject({
      code: "claim_collision",
    });
    expect(
      await new GitSubmissionAuthority(home, fixture.git).read(identity, fixture.alice),
    ).toBeDefined();
  } finally {
    await fixture.dispose();
  }
});
