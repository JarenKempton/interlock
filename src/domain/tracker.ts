import type {
  ActorRef,
  ClaimRef,
  MapRef,
  RunRef,
  Ticket,
  TicketRef,
  TrackerSnapshot,
} from "./model.ts";

export type TrackerCapability =
  | "native_maps"
  | "native_dependencies"
  | "transition"
  | "link_artifact";
export type TrackerCapabilities = Partial<Record<TrackerCapability, true>>;

export interface TrackerRead {
  ticket: Ticket;
  snapshot: TrackerSnapshot;
}

export interface TrackerReader {
  list_work(map: MapRef): Promise<Ticket[]>;
  read(ticket: TicketRef): Promise<TrackerRead>;
}

export interface MirrorClaim {
  ticket: TicketRef;
  claim: ClaimRef;
  run: RunRef;
  owner: ActorRef;
  supersedes?: ClaimRef | undefined;
}

export interface MirrorRestore {
  ticket: TicketRef;
  claim: ClaimRef;
  claimedOwner: ActorRef;
  originalSnapshot: TrackerSnapshot;
}

export type MirrorExpectation =
  | ({ state: "applied" } & MirrorClaim)
  | ({ state: "restored" } & MirrorRestore);

export interface TrackerMirror {
  apply(request: MirrorClaim): Promise<void>;
  verify(request: MirrorExpectation): Promise<void>;
  restore(request: MirrorRestore): Promise<void>;
}

export interface Tracker extends TrackerReader, TrackerMirror {
  describe(): Promise<TrackerCapabilities>;
  transition?(ticket: TicketRef, status: string): Promise<void>;
  link_artifact?(ticket: TicketRef, url: string): Promise<void>;
}
