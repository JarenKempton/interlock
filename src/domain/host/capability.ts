import type { AdapterRef, LaneRef, TicketRef } from "../model.ts";
import type { OperationIdentity } from "../operation/identity.ts";

export interface HostSession {
  environment: string;
  host: AdapterRef;
  harness: AdapterRef;
  session: string;
  lane: LaneRef;
  ticket: TicketRef;
}

export interface HostSessionView {
  session: HostSession;
  status: string;
  link?: string;
  workspace?: { path: string; branch: string };
  messages: readonly { role: string; text: string }[];
}

export type HostLaunchResult =
  | { state: "launched"; session: HostSession; view: HostSessionView }
  | { state: "ambiguous"; reason: string; acknowledged: boolean };

export type HostRecoveryResult =
  | { state: "found"; session: HostSession; view: HostSessionView }
  | { state: "not_launched"; evidence: string }
  | { state: "ambiguous"; reason: string };

export type HostSteerResult = { state: "delivered" } | { state: "ambiguous"; reason: string };

export interface HostCapability<PickupPlan> {
  preflight(): Promise<void>;
  launch(request: { operation: OperationIdentity; plan: PickupPlan }): Promise<HostLaunchResult>;
  find(query: { lane: LaneRef } | { ticket: TicketRef }): Promise<readonly HostSession[]>;
  read(session: HostSession): Promise<HostSessionView>;
  steer(request: {
    operation: OperationIdentity;
    session: HostSession;
    message: string;
  }): Promise<HostSteerResult>;
  recover(request: { operation: OperationIdentity; plan: PickupPlan }): Promise<HostRecoveryResult>;
}

export class HostRefusal extends Error {
  constructor(
    readonly code: "host_unavailable" | "host_incompatible" | "host_unsupported" | "branch_exists",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "HostRefusal";
  }
}

export class HostLaunchUnresolvedError extends Error {
  readonly code = "ambiguous_launch";

  constructor(readonly reason: string) {
    super(`Host launch is unresolved: ${reason}`);
    this.name = "HostLaunchUnresolvedError";
  }
}
