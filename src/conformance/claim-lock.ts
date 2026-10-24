import type { ClaimLock, ClaimLockRecord, ClaimLockState } from "../domain/claim-lock.ts";
import type { ClaimRequest, ReleaseClaimRequest } from "../domain/contracts.ts";
import type { ActorRef } from "../domain/model.ts";
import { type ConformanceCase, requireBehavior, requireRejection } from "./runner.ts";

export interface ClaimLockFixture {
  adapter: ClaimLock;
  contender: ClaimLock;
  request: ClaimRequest;
  otherOwner: ActorRef;
  loseWriteReadback(): void | Promise<void>;
  expireLease(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export function claimLockConformance(create: () => Promise<ClaimLockFixture>): ConformanceCase[] {
  function scenario(name: string, run: (fixture: ClaimLockFixture) => Promise<void>) {
    return {
      name: `claim_lock.${name}`,
      async run() {
        const fixture = await create();
        try {
          await run(fixture);
        } finally {
          await fixture.dispose?.();
        }
      },
    };
  }
  return [
    scenario("collision", async ({ adapter, contender, request, otherOwner }) => {
      requireBehavior(
        (await adapter.describe()).conditional_update === true,
        "Lock must verify conditional writes",
      );
      const initial = await adapter.read(request.ticket);
      const results = await Promise.allSettled([
        adapter.claim({ ...request, expectedVersion: initial.version }),
        contender.claim({
          ...request,
          claim: "interlock-claim:contender",
          run: "interlock-run:contender",
          owner: otherOwner,
          expectedVersion: initial.version,
        }),
      ]);
      requireBehavior(
        results.filter((result) => result.status === "fulfilled").length === 1,
        "Collision did not have exactly one winner",
      );
      const rejected = results.find((result) => result.status === "rejected");
      requireBehavior(
        rejected?.status === "rejected" && rejected.reason?.code === "claim_collision",
        "Collision was not reported explicitly",
      );
      const held = await adapter.read(request.ticket);
      const expected =
        results[0]?.status === "fulfilled"
          ? request
          : {
              ...request,
              claim: "interlock-claim:contender" as const,
              run: "interlock-run:contender" as const,
              owner: otherOwner,
            };
      requireBehavior(held.version !== initial.version, "Claim did not change the version");
      requireRecord(held.record, {
        action: "claim",
        ticket: expected.ticket,
        claim: expected.claim,
        run: expected.run,
        owner: expected.owner,
        leaseExpiresAt: expected.leaseExpiresAt,
      });
    }),
    scenario("stale_version", async (fixture) => {
      const { adapter, request } = fixture;
      const initial = await adapter.read(request.ticket);
      await adapter.claim({ ...request, expectedVersion: initial.version });
      const held = await adapter.read(request.ticket);
      const renew = {
        ticket: request.ticket,
        claim: request.claim,
        leaseExpiresAt: "2099-01-01T01:00:00.000Z",
        expectedVersion: initial.version,
      };
      await requireRejection(() => adapter.renew(renew), "claim_collision");
      requireUnchanged(await adapter.read(request.ticket), held);
      await requireRejection(
        () => adapter.release(release(fixture, initial.version)),
        "claim_collision",
      );
      requireUnchanged(await adapter.read(request.ticket), held);
      await adapter.renew({ ...renew, expectedVersion: held.version });
      const renewed = await adapter.read(request.ticket);
      requireBehavior(renewed.version !== held.version, "Renewal did not change the version");
      requireRecord(renewed.record, {
        action: "renew",
        ticket: request.ticket,
        claim: request.claim,
        run: request.run,
        owner: request.owner,
        leaseExpiresAt: renew.leaseExpiresAt,
      });
      await adapter.release(release(fixture, renewed.version));
      const released = await adapter.read(request.ticket);
      requireBehavior(released.version !== renewed.version, "Release did not change the version");
      requireRecord(released.record, {
        action: "release",
        ticket: request.ticket,
        claim: request.claim,
        run: request.run,
        owner: request.owner,
        leaseExpiresAt: renew.leaseExpiresAt,
        authorizedBy: request.owner,
      });
      await requireRejection(
        () =>
          adapter.claim({
            ...request,
            claim: "interlock-claim:stale",
            run: "interlock-run:stale",
            expectedVersion: initial.version,
          }),
        "claim_collision",
      );
      requireUnchanged(await adapter.read(request.ticket), released);
    }),
    scenario("authority", async (fixture) => {
      const { adapter, request, otherOwner } = fixture;
      await adapter.claim(request);
      const held = await adapter.read(request.ticket);
      await requireRejection(
        () => adapter.release({ ...release(fixture, held.version), authorizedBy: otherOwner }),
        "claim_collision",
      );
      requireUnchanged(await adapter.read(request.ticket), held);
      await requireRejection(
        () =>
          adapter.release({ ...release(fixture, held.version), claim: "interlock-claim:other" }),
        "claim_collision",
      );
      requireUnchanged(await adapter.read(request.ticket), held);
      await requireRejection(
        () =>
          adapter.renew({
            ticket: request.ticket,
            claim: "interlock-claim:other",
            expectedVersion: held.version,
            leaseExpiresAt: request.leaseExpiresAt,
          }),
        "claim_collision",
      );
      requireUnchanged(await adapter.read(request.ticket), held);
    }),
    scenario("expiry_is_observational", async ({ adapter, request, expireLease }) => {
      await adapter.claim(request);
      const held = await adapter.read(request.ticket);
      await expireLease();
      requireBehavior(
        (await adapter.read(request.ticket)).version === held.version,
        "Expiry mutated the lock",
      );
      await requireRejection(
        () =>
          adapter.claim({
            ...request,
            claim: "interlock-claim:other",
            leaseExpiresAt: "2101-01-01T00:15:00.000Z",
            expectedVersion: held.version,
          }),
        "claim_collision",
      );
      requireBehavior(
        (await adapter.read(request.ticket)).version === held.version,
        "Expired claim was reassigned automatically",
      );
    }),
    ...(["claim", "renew", "release"] as const).map((operation) =>
      scenario(`ambiguous_${operation}`, async (fixture) => {
        const { adapter, request, loseWriteReadback } = fixture;
        if (operation !== "claim") await adapter.claim(request);
        const state = await adapter.read(request.ticket);
        await loseWriteReadback();
        await requireRejection(() => {
          if (operation === "claim")
            return adapter.claim({ ...request, expectedVersion: state.version });
          if (operation === "release") return adapter.release(release(fixture, state.version));
          return adapter.renew({
            ticket: request.ticket,
            claim: request.claim,
            expectedVersion: state.version,
            leaseExpiresAt: "2099-01-01T01:00:00.000Z",
          });
        }, "ambiguous_tracker_result");
      }),
    ),
  ];
}

function release(fixture: ClaimLockFixture, expectedVersion: string): ReleaseClaimRequest {
  return {
    ticket: fixture.request.ticket,
    claim: fixture.request.claim,
    authorizedBy: fixture.request.owner,
    claimedOwner: fixture.request.owner,
    expectedVersion,
    originalSnapshot: { version: "opaque", payload: null },
  };
}

function requireRecord(actual: ClaimLockRecord | null, expected: ClaimLockRecord) {
  requireBehavior(
    actual &&
      actual.action === expected.action &&
      actual.ticket === expected.ticket &&
      actual.claim === expected.claim &&
      actual.run === expected.run &&
      actual.owner === expected.owner &&
      actual.leaseExpiresAt === expected.leaseExpiresAt &&
      actual.supersedes === expected.supersedes &&
      actual.authorizedBy === expected.authorizedBy,
    "Lock record does not preserve the exact identity and lease",
  );
}

function requireUnchanged(actual: ClaimLockState, expected: ClaimLockState) {
  requireBehavior(actual.version === expected.version, "Refused write changed the lock version");
  if (expected.record) requireRecord(actual.record, expected.record);
  else requireBehavior(actual.record === null, "Refused write created a lock record");
}
