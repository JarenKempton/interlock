import type { ActorRef, Ticket } from "../domain/model.ts";
import type { MirrorClaim, MirrorRestore, Tracker } from "../domain/tracker.ts";
import { type ConformanceCase, requireBehavior, requireRejection } from "./runner.ts";

export interface TrackerObservation {
  ticket: Ticket;
  mirror: MirrorClaim | null;
  writes: number;
}

export interface TrackerFixture {
  adapter: Tracker;
  claim: MirrorClaim;
  otherOwner: ActorRef;
  observe(): Promise<TrackerObservation>;
  changeOwner(owner: ActorRef): Promise<void>;
  loseWriteReadback(): void | Promise<void>;
}

export function trackerConformance(create: () => Promise<TrackerFixture>): ConformanceCase[] {
  function scenario(name: string, run: (fixture: TrackerFixture) => Promise<void>) {
    return { name: `tracker.${name}`, run: async () => run(await create()) };
  }
  return [
    scenario("read_only", async ({ adapter, claim, observe }) => {
      const before = await observe();
      const read = await adapter.read(claim.ticket);
      const listed = await adapter.list_work(read.ticket.map);
      requireBehavior(read.ticket.ref === claim.ticket, "read returned a different ticket");
      requireBehavior(
        listed.some((ticket) => ticket.ref === claim.ticket),
        "list_work lost ticket",
      );
      requireBehavior((await observe()).writes === before.writes, "Tracker reads mutated state");
      requireBehavior(
        !("conditional_update" in (await adapter.describe())),
        "Tracker advertised version-checked writes",
      );
    }),
    scenario("mirror_and_restore", async (fixture) => {
      const { adapter, claim, observe } = fixture;
      const original = await adapter.read(claim.ticket);
      await requireRejection(
        () => adapter.verify({ ...claim, state: "applied" }),
        "ambiguous_tracker_result",
      );
      await adapter.apply(claim);
      await adapter.verify({ ...claim, state: "applied" });
      const applied = await observe();
      requireBehavior(
        applied.mirror?.claim === claim.claim &&
          applied.mirror.run === claim.run &&
          applied.ticket.assignee === claim.owner,
        "Mirror did not install the exact holder",
      );
      await adapter.apply(claim);
      requireBehavior((await observe()).writes === applied.writes, "Repeated apply wrote again");
      for (const conflicting of [
        { ...claim, run: "interlock-run:different" as const },
        { ...claim, owner: fixture.otherOwner },
      ]) {
        await requireRejection(() => adapter.apply(conflicting), "claim_collision");
        requireBehavior((await observe()).writes === applied.writes, "Rejected apply wrote");
      }
      const restore = restoration(fixture, original.snapshot);
      await requireRejection(
        () => adapter.verify({ ...restore, state: "restored" }),
        "ambiguous_tracker_result",
      );
      await adapter.restore(restore);
      await adapter.verify({ ...restore, state: "restored" });
      const restored = await observe();
      requireBehavior(
        restored.mirror === null &&
          restored.ticket.assignee === original.ticket.assignee &&
          restored.ticket.status === original.ticket.status,
        "Restoration lost original fields",
      );
      await adapter.restore(restore);
      requireBehavior((await observe()).writes === restored.writes, "Repeated restore wrote");
    }),
    scenario("preserve_human_change", async (fixture) => {
      const { adapter, claim, observe, changeOwner, otherOwner } = fixture;
      const original = await adapter.read(claim.ticket);
      await adapter.apply(claim);
      await changeOwner(otherOwner);
      const before = await observe();
      await requireRejection(
        () => adapter.restore(restoration(fixture, original.snapshot)),
        "claim_collision",
      );
      const after = await observe();
      requireBehavior(
        after.ticket.assignee === otherOwner && after.writes === before.writes,
        "Restoration overwrote a human change",
      );
    }),
    scenario("ambiguous_apply", async ({ adapter, claim, loseWriteReadback }) => {
      await loseWriteReadback();
      await requireRejection(() => adapter.apply(claim), "ambiguous_tracker_result");
    }),
    scenario("ambiguous_restore", async (fixture) => {
      const { adapter, claim, loseWriteReadback } = fixture;
      const original = await adapter.read(claim.ticket);
      await adapter.apply(claim);
      await loseWriteReadback();
      await requireRejection(
        () => adapter.restore(restoration(fixture, original.snapshot)),
        "ambiguous_tracker_result",
      );
    }),
  ];
}

function restoration(
  fixture: TrackerFixture,
  originalSnapshot: MirrorRestore["originalSnapshot"],
): MirrorRestore {
  return {
    ticket: fixture.claim.ticket,
    claim: fixture.claim.claim,
    claimedOwner: fixture.claim.owner,
    originalSnapshot,
  };
}
