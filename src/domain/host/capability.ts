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

export type HostLaunchResult =
  | { state: "launched"; session: HostSession }
  | { state: "ambiguous"; reason: string };

export type HostRecoveryResult =
  | { state: "found"; session: HostSession }
  | { state: "not_launched"; evidence: string }
  | { state: "ambiguous"; reason: string };

export interface HostCapability<PickupPlan> {
  launch(request: { operation: OperationIdentity; plan: PickupPlan }): Promise<HostLaunchResult>;
  find(query: { lane: LaneRef } | { ticket: TicketRef }): Promise<readonly HostSession[]>;
  steer(request: {
    operation: OperationIdentity;
    session: HostSession;
    message: string;
  }): Promise<{ state: "delivered" } | { state: "ambiguous"; reason: string }>;
  recover(request: { operation: OperationIdentity; plan: PickupPlan }): Promise<HostRecoveryResult>;
}
