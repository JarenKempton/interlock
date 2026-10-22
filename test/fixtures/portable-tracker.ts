import type { TrackerFixture, TrackerObservation } from "../../src/conformance/tracker.ts";
import { AmbiguousTrackerResultError, ClaimCollisionError } from "../../src/domain/contracts.ts";
import { actorRefSchema, mapRefSchema, ticketRefSchema } from "../../src/domain/identifiers.ts";
import type { MirrorClaim, MirrorRestore, Tracker } from "../../src/domain/tracker.ts";

export function fakeTrackerFixture(fault?: "drop_artifacts" | "reject_successor"): TrackerFixture {
  const claim: MirrorClaim = {
    ticket: ticketRefSchema.parse("fake:test:WORK:ticket:T-1"),
    claim: "interlock-claim:conformance",
    run: "interlock-run:conformance",
    owner: actorRefSchema.parse("human"),
  };
  const state: TrackerObservation = {
    ticket: {
      ref: claim.ticket,
      map: mapRefSchema.parse("fake:test:WORK:map:M-1"),
      kind: "task",
      state: "open",
      status: "To Do",
      order: 0,
    },
    mirror: null,
    artifacts: [],
    writes: 0,
  };
  const snapshots = new Map<string, TrackerObservation>();
  let failReadback = false;
  let unreadable = false;
  function checkedRead() {
    if (unreadable) throw new AmbiguousTrackerResultError();
    return structuredClone(state);
  }
  function write(change: () => void) {
    change();
    state.writes += 1;
    if (failReadback) unreadable = true;
    checkedRead();
  }
  function original(request: MirrorRestore) {
    const saved = snapshots.get(request.originalSnapshot.version);
    if (!saved) throw new Error("Unknown snapshot");
    return saved;
  }
  const adapter: Tracker = {
    async describe() {
      return { transition: true, link_artifact: true };
    },
    async list_work() {
      return [checkedRead().ticket];
    },
    async read() {
      const value = checkedRead();
      const version = String(value.writes);
      snapshots.set(version, value);
      return {
        ticket: value.ticket,
        snapshot: { version, payload: { token: version } },
        artifacts: value.artifacts,
      };
    },
    async apply(request) {
      checkedRead();
      if (
        state.mirror?.claim === request.claim &&
        state.mirror.run === request.run &&
        state.mirror.owner === request.owner &&
        state.mirror.supersedes === request.supersedes &&
        state.ticket.assignee === request.owner
      )
        return;
      const replacing =
        fault !== "reject_successor" &&
        request.supersedes !== undefined &&
        state.mirror?.claim === request.supersedes;
      const expectedOwner = replacing ? state.mirror?.owner : request.owner;
      if (
        (state.mirror && state.mirror.claim !== request.claim && !replacing) ||
        (request.supersedes && !state.mirror) ||
        (state.ticket.assignee && state.ticket.assignee !== expectedOwner)
      )
        throw new ClaimCollisionError();
      write(() => {
        state.mirror = structuredClone(request);
        state.ticket.assignee = request.owner;
        state.ticket.status = "In Progress";
      });
    },
    async verify(request) {
      const current = checkedRead();
      if (request.state === "applied") {
        if (
          current.mirror?.claim !== request.claim ||
          current.mirror.run !== request.run ||
          current.mirror.owner !== request.owner ||
          current.mirror.supersedes !== request.supersedes ||
          current.ticket.assignee !== request.owner ||
          current.ticket.status !== "In Progress"
        )
          throw new AmbiguousTrackerResultError();
      } else {
        const saved = original(request);
        if (
          current.mirror?.claim === request.claim ||
          (current.ticket.assignee === request.claimedOwner &&
            saved.ticket.assignee !== request.claimedOwner) ||
          (current.ticket.status === "In Progress" && saved.ticket.status !== "In Progress")
        )
          throw new AmbiguousTrackerResultError();
      }
    },
    async restore(request) {
      checkedRead();
      if (state.mirror?.claim !== request.claim) return;
      const saved = original(request);
      if (
        (state.ticket.assignee !== request.claimedOwner &&
          state.ticket.assignee !== saved.ticket.assignee) ||
        (state.ticket.status !== "In Progress" && state.ticket.status !== saved.ticket.status)
      )
        throw new ClaimCollisionError();
      write(() => {
        state.mirror = structuredClone(saved.mirror);
        state.ticket.status = saved.ticket.status;
        if (saved.ticket.assignee) state.ticket.assignee = saved.ticket.assignee;
        else delete state.ticket.assignee;
        if (fault === "drop_artifacts") state.artifacts = saved.artifacts;
      });
    },
    async transition(_ticket, status) {
      if (checkedRead().ticket.status === status) return;
      write(() => {
        state.ticket.status = status;
      });
    },
    async link_artifact(_ticket, url) {
      if (checkedRead().artifacts.includes(url)) return;
      write(() => {
        state.artifacts = [...state.artifacts, url];
      });
    },
  };
  return {
    adapter,
    claim,
    otherOwner: actorRefSchema.parse("other-human"),
    observe: async () => structuredClone(state),
    addArtifact: async (url) => {
      state.artifacts = [...state.artifacts, url];
    },
    changeOwner: async (owner) => {
      state.ticket.assignee = owner;
    },
    loseWriteReadback: () => {
      failReadback = true;
    },
  };
}
