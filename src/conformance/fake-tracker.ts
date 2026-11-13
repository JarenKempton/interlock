import { AmbiguousTrackerResultError, ClaimCollisionError } from "../domain/contracts.ts";
import { actorRefSchema, mapRefSchema, ticketRefSchema } from "../domain/refs/identifiers.ts";
import type {
  MirrorClaim,
  MirrorRestore,
  MirrorTier,
  Tracker,
  TrackerRead,
} from "../domain/tracker/port.ts";
import type { TrackerFixture, TrackerObservation } from "./tracker.ts";

const CLAIMED_STATUS = "In Progress";

export function fakeTrackerFixture(mirror: MirrorTier = "structured"): TrackerFixture {
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
      state: "open",
      status: "To Do",
    },
    mirror: null,
    writes: 0,
  };
  const structured = mirror === "structured";
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
  function holds(request: MirrorClaim) {
    return structured
      ? state.mirror?.claim === request.claim &&
          state.mirror.run === request.run &&
          state.mirror.owner === request.owner
      : state.ticket.assignee === request.owner;
  }
  const operations = {
    async listWork() {
      return [checkedRead().ticket];
    },
    async read(): Promise<TrackerRead> {
      const value = checkedRead();
      const version = String(value.writes);
      snapshots.set(version, value);
      return { ticket: value.ticket, snapshot: { version, payload: { token: version } } };
    },
    async apply(request: MirrorClaim) {
      checkedRead();
      if (holds(request) && (structured || state.ticket.status === CLAIMED_STATUS)) return;
      if (
        (structured && state.mirror) ||
        (state.ticket.assignee && state.ticket.assignee !== request.owner)
      )
        throw new ClaimCollisionError();
      write(() => {
        if (structured) state.mirror = structuredClone(request);
        state.ticket.assignee = request.owner;
        state.ticket.status = CLAIMED_STATUS;
      });
    },
    async verify(request: Parameters<Tracker["verify"]>[0]) {
      const current = checkedRead();
      if (request.state === "applied") {
        if (
          (structured &&
            (current.mirror?.claim !== request.claim || current.mirror.run !== request.run)) ||
          current.ticket.assignee !== request.owner ||
          current.ticket.status !== CLAIMED_STATUS
        )
          throw new AmbiguousTrackerResultError();
        return;
      }
      const saved = original(request);
      if (
        current.mirror?.claim === request.claim ||
        (current.ticket.assignee === request.claimedOwner &&
          saved.ticket.assignee !== request.claimedOwner) ||
        (current.ticket.status === CLAIMED_STATUS && saved.ticket.status !== CLAIMED_STATUS)
      )
        throw new AmbiguousTrackerResultError();
    },
    async restore(request: MirrorRestore) {
      checkedRead();
      const saved = original(request);
      if (structured && state.mirror?.claim !== request.claim) return;
      if (
        !structured &&
        state.ticket.assignee === saved.ticket.assignee &&
        state.ticket.status === saved.ticket.status
      )
        return;
      if (
        (state.ticket.assignee !== request.claimedOwner &&
          state.ticket.assignee !== saved.ticket.assignee) ||
        (state.ticket.status !== CLAIMED_STATUS && state.ticket.status !== saved.ticket.status)
      )
        throw new ClaimCollisionError();
      write(() => {
        state.mirror = structuredClone(saved.mirror);
        state.ticket.status = saved.ticket.status;
        if (saved.ticket.assignee) state.ticket.assignee = saved.ticket.assignee;
        else delete state.ticket.assignee;
      });
    },
    async removeMirror(request: MirrorClaim) {
      checkedRead();
      if (!state.mirror) return;
      if (!holds(request)) throw new ClaimCollisionError();
      write(() => {
        state.mirror = null;
      });
    },
  };
  const adapter: Tracker = structured
    ? {
        mirror: "structured",
        ...operations,
        async claimMarker() {
          const marker = checkedRead().mirror;
          return marker && { ...marker, home: "fake" };
        },
      }
    : { mirror: "assignee_only", ...operations };
  return {
    adapter,
    claim,
    otherOwner: actorRefSchema.parse("other-human"),
    observe: async () => structuredClone(state),
    changeOwner: async (owner) => {
      state.ticket.assignee = owner;
    },
    loseWriteReadback: () => {
      failReadback = true;
    },
  };
}
