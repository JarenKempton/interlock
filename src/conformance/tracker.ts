import type { ActorRef, Ticket } from "../domain/model.ts";
import type { MirrorClaim, MirrorRestore, Tracker } from "../domain/tracker.ts";
import { type ConformanceCase, requireBehavior, requireRejection } from "./runner.ts";

export interface TrackerObservation {
  ticket: Ticket;
  mirror: MirrorClaim | null;
  artifacts: readonly string[];
  writes: number;
}

export interface TrackerFixture {
  adapter: Tracker;
  claim: MirrorClaim;
  otherOwner: ActorRef;
  observe(): Promise<TrackerObservation>;
  changeOwner(owner: ActorRef): Promise<void>;
  addArtifact(url: string): Promise<void>;
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
      const capabilities = await adapter.describe();
      const allowed = new Set([
        "native_maps",
        "native_dependencies",
        "transition",
        "link_artifact",
      ]);
      requireBehavior(
        Object.keys(capabilities).every((key) => allowed.has(key)),
        "Tracker advertised ownership guarantees or unknown capabilities",
      );
      requireBehavior(
        !("claim" in adapter || "renew" in adapter || "release" in adapter),
        "Tracker exposes lock operations",
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
          applied.mirror.owner === claim.owner &&
          applied.ticket.assignee === claim.owner,
        "Mirror did not install the exact holder",
      );
      await adapter.apply(claim);
      requireBehavior(
        (await observe()).writes === applied.writes,
        "Repeated apply performed another write",
      );
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
      requireBehavior(
        (await observe()).writes === restored.writes,
        "Repeated restore performed another write",
      );
    }),
    scenario("preserve_artifacts", async (fixture) => {
      const { adapter, claim, addArtifact, observe } = fixture;
      const original = await adapter.read(claim.ticket);
      await adapter.apply(claim);
      await addArtifact(artifact);
      await adapter.restore(restoration(fixture, original.snapshot));
      await adapter.verify({ ...restoration(fixture, original.snapshot), state: "restored" });
      requireBehavior(
        (await observe()).artifacts.includes(artifact) &&
          (await adapter.read(claim.ticket)).artifacts.includes(artifact),
        "Restoration deleted unrelated artifact evidence",
      );
    }),
    scenario("authorized_successor", async (fixture) => {
      const { adapter, claim, otherOwner, observe } = fixture;
      const original = await adapter.read(claim.ticket);
      await adapter.apply(claim);
      const successor: MirrorClaim = {
        ...claim,
        claim: "interlock-claim:successor",
        run: "interlock-run:successor",
        owner: otherOwner,
        supersedes: claim.claim,
      };
      const before = await observe();
      await requireRejection(
        () => adapter.apply({ ...successor, supersedes: "interlock-claim:unrelated" }),
        "claim_collision",
      );
      requireBehavior(
        (await observe()).writes === before.writes,
        "Mismatched predecessor changed the mirror",
      );
      await adapter.apply(successor);
      await adapter.verify({ ...successor, state: "applied" });
      const applied = await observe();
      requireBehavior(
        applied.mirror?.claim === successor.claim &&
          applied.mirror.supersedes === claim.claim &&
          applied.mirror.run === successor.run &&
          applied.mirror.owner === otherOwner &&
          applied.ticket.assignee === otherOwner,
        "Authorized successor was not mirrored",
      );
      await adapter.apply(successor);
      requireBehavior((await observe()).writes === applied.writes, "Successor retry wrote again");
      const restore = {
        ticket: claim.ticket,
        claim: successor.claim,
        claimedOwner: otherOwner,
        originalSnapshot: original.snapshot,
      };
      await adapter.restore(restore);
      await adapter.verify({ ...restore, state: "restored" });
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
    ...(["transition", "link_artifact"] as const).flatMap((capability) => [
      scenario(`${capability}_idempotent`, async ({ adapter, claim, observe }) => {
        if (!(await adapter.describe())[capability]) return;
        const write = trackerWrite(adapter, capability, claim);
        await write();
        const first = await observe();
        const read = await adapter.read(claim.ticket);
        if (capability === "transition") {
          requireBehavior(
            first.ticket.status === "Done" && read.ticket.status === "Done",
            "Transition was not read back",
          );
        } else {
          requireBehavior(
            first.artifacts.filter((url) => url === artifact).length === 1 &&
              read.artifacts.includes(artifact),
            "Artifact link was not read back",
          );
        }
        await write();
        requireBehavior(
          (await observe()).writes === first.writes,
          "Repeated tracker write was not idempotent",
        );
      }),
      scenario(`${capability}_ambiguous`, async ({ adapter, claim, loseWriteReadback }) => {
        if (!(await adapter.describe())[capability]) return;
        const write = trackerWrite(adapter, capability, claim);
        await loseWriteReadback();
        await requireRejection(write, "ambiguous_tracker_result");
      }),
    ]),
  ];
}

const artifact = "https://example.invalid/pull/1";

function trackerWrite(
  adapter: Tracker,
  capability: "transition" | "link_artifact",
  claim: MirrorClaim,
) {
  if (capability === "transition") {
    const operation = adapter.transition?.bind(adapter);
    requireBehavior(operation, "Advertised transition has no implementation");
    return () => operation(claim.ticket, "Done");
  }
  const operation = adapter.link_artifact?.bind(adapter);
  requireBehavior(operation, "Advertised link_artifact has no implementation");
  return () => operation(claim.ticket, artifact);
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
