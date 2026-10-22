import type { ClaimLock } from "../domain/claim-lock.ts";
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
    scenario("collision", async ({ adapter, contender, request }) => {
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
        results[0]?.status === "fulfilled" ? request.claim : "interlock-claim:contender";
      requireBehavior(
        held.record?.claim === expected &&
          held.record.action === "claim" &&
          held.record.owner === request.owner &&
          held.version !== initial.version,
        "Winner was not durably installed",
      );
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
      await requireRejection(
        () => adapter.release(release(fixture, initial.version)),
        "claim_collision",
      );
      requireBehavior(
        (await adapter.read(request.ticket)).version === held.version,
        "Stale writes changed the lock",
      );
      await adapter.renew({ ...renew, expectedVersion: held.version });
      const renewed = await adapter.read(request.ticket);
      requireBehavior(
        renewed.record?.claim === request.claim &&
          renewed.record.leaseExpiresAt === renew.leaseExpiresAt &&
          renewed.version !== held.version,
        "Renewal was not verified",
      );
      await adapter.release(release(fixture, renewed.version));
      const released = await adapter.read(request.ticket);
      requireBehavior(
        released.record?.action === "release" &&
          released.record.claim === request.claim &&
          released.version !== renewed.version,
        "Release was not verified",
      );
    }),
    scenario("authority", async (fixture) => {
      const { adapter, request, otherOwner } = fixture;
      await adapter.claim(request);
      const held = await adapter.read(request.ticket);
      await requireRejection(
        () => adapter.release({ ...release(fixture, held.version), authorizedBy: otherOwner }),
        "claim_collision",
      );
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
      requireBehavior(
        (await adapter.read(request.ticket)).version === held.version,
        "Wrong authority changed the lock",
      );
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
