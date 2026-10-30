import type { z } from "zod";
import type {
  ActorRef,
  ClaimRef,
  MapRef,
  RunRef,
  Ticket,
  TicketRef,
  TrackerSnapshot,
} from "./model.ts";

export type TrackerCapability = "transition" | "link_artifact";
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

export interface CredentialField<Name extends string = string> {
  name: Name;
  label: string;
  environment: string;
  hidden: boolean;
  normalize?(value: string): string;
}

export interface TrackerSignIn<
  Credentials extends Record<string, string> = Record<string, string>,
> {
  site: { label: string; environment: string; parse(value: string): string };
  tokenPage: string;
  fields: readonly CredentialField<Extract<keyof Credentials, string>>[];
  credentials: z.ZodType<Credentials>;
  verify(site: string, credentials: Credentials): Promise<{ name: string }>;
  missingPermissions(site: string, credentials: Credentials, project?: string): Promise<string[]>;
}

export interface Tracker extends TrackerReader, TrackerMirror {
  describe(): Promise<TrackerCapabilities>;
  transition?(ticket: TicketRef, status: string): Promise<void>;
  link_artifact?(ticket: TicketRef, url: string, title?: string): Promise<void>;
}
