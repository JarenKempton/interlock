import type { z } from "zod";
import type { ActorRef, ClaimRef, MapRef, RunRef, TicketRef, TrackerSnapshot } from "../model.ts";
import type { Ticket } from "./ticket.ts";

export interface TrackerRead {
  ticket: Ticket;
  snapshot: TrackerSnapshot;
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

export interface ClaimMarker {
  claim: string;
  run: string;
  owner: string;
  home: string;
}

interface TrackerBase {
  read(ticket: TicketRef): Promise<TrackerRead>;
  listWork?(map: MapRef): Promise<Ticket[]>;
  apply(request: MirrorClaim): Promise<void>;
  verify(request: MirrorExpectation): Promise<void>;
  restore(request: MirrorRestore): Promise<void>;
  removeMirror(request: MirrorClaim): Promise<void>;
  complete?(ticket: TicketRef): Promise<void>;
  linkArtifact?(ticket: TicketRef, url: string, title?: string): Promise<void>;
  pendingWrite?(ticket: TicketRef): unknown;
  verifyPendingWrite?(pending: unknown, ticket: TicketRef): Promise<void>;
}

export interface StructuredTracker extends TrackerBase {
  readonly mirror: "structured";
  claimMarker(ticket: TicketRef): Promise<ClaimMarker | null>;
}

export interface AssigneeOnlyTracker extends TrackerBase {
  readonly mirror: "assignee_only";
}

export type Tracker = StructuredTracker | AssigneeOnlyTracker;
export type MirrorTier = Tracker["mirror"];

export interface CredentialField<Name extends string = string> {
  name: Name;
  label: string;
  environment: string;
  hidden: boolean;
  normalize?(value: string): string;
}

export interface TokenSignIn<Credentials extends Record<string, string> = Record<string, string>> {
  kind: "token";
  site: { label: string; environment: string; parse(value: string): string };
  tokenPage: string;
  fields: readonly CredentialField<Extract<keyof Credentials, string>>[];
  credentials: z.ZodType<Credentials>;
  verify(site: string, credentials: Credentials): Promise<{ name: string }>;
  permissions?: {
    summary: string;
    missing(site: string, credentials: Credentials, project?: string): Promise<string[]>;
  };
}

export interface ExternalCliSignIn {
  kind: "external_cli";
  command: string;
  verify(): Promise<{ name: string }>;
}

export interface NoSignIn {
  kind: "none";
}

export type TrackerSignIn<Credentials extends Record<string, string> = Record<string, string>> =
  | NoSignIn
  | ExternalCliSignIn
  | TokenSignIn<Credentials>;

export type PickableStatuses = (ticket: Ticket) => readonly string[] | undefined;
