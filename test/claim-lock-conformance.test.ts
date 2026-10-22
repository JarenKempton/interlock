import { expect, test } from "bun:test";
import { GitClaimLock } from "../src/adapters/claims/git-lock.ts";
import { claimLockConformance } from "../src/conformance/claim-lock.ts";
import { runConformance } from "../src/conformance/runner.ts";
import type { ClaimLock } from "../src/domain/claim-lock.ts";
import { actorRefSchema, ticketRefSchema } from "../src/domain/identifiers.ts";
import { GIT_TEST_TIMEOUT_MS, gitRemoteFixture, ScriptedGit } from "./fixtures/git-remote.ts";

test(
  "portable lock conformance exercises the Git adapter against an isolated bare remote",
  async () => {
    const report = await runConformance(
      claimLockConformance(async () => {
        const fixture = await gitRemoteFixture();
        const scripted = new ScriptedGit(fixture.git);
        function adapter(repository: string, git = fixture.git): ClaimLock {
          const lock = new GitClaimLock({
            repository,
            remote: fixture.remote,
            git,
            clock: fixture.clock,
          });
          return {
            describe: async () => ({ conditional_update: true }),
            read: lock.read.bind(lock),
            claim: lock.claim.bind(lock),
            renew: lock.renew.bind(lock),
            release: lock.release.bind(lock),
          };
        }
        return {
          adapter: adapter(fixture.alice, scripted),
          contender: adapter(fixture.bob),
          request: {
            ticket: ticketRefSchema.parse("fake:test:WORK:ticket:T-1"),
            claim: "interlock-claim:conformance",
            run: "interlock-run:conformance",
            owner: actorRefSchema.parse("human"),
            leaseExpiresAt: "2099-01-01T00:15:00.000Z",
            expectedVersion: "absent",
          },
          otherOwner: actorRefSchema.parse("other-human"),
          expireLease: () => fixture.clock.set("2100-01-01T00:00:00.000Z"),
          loseWriteReadback: () => {
            scripted.push = async (push) => {
              const result = await push();
              scripted.lsRemoteFailuresAfterPush = 1;
              return result;
            };
          },
          dispose: fixture.dispose,
        };
      }),
    );
    expect(report.results.filter((result) => !result.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  },
  GIT_TEST_TIMEOUT_MS,
);
