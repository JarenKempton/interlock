import type { LaunchRequest } from "./contracts.ts";
import type { PreparedWorkspace, RunRef, TicketRef } from "./model.ts";

export const HOST_CAPABILITIES = [
  "message",
  "interrupt",
  "focus",
  "subagents",
  "pr_ownership",
] as const;
export type HostCapability = (typeof HOST_CAPABILITIES)[number];
export type HostCapabilities = Partial<Record<HostCapability, true>>;

export interface HostSession {
  id: string;
  run: RunRef;
  ticket: TicketRef;
  workspace: PreparedWorkspace;
  state: "running" | "stopped";
}

export interface Host {
  describe(): Promise<HostCapabilities>;
  launch(request: LaunchRequest): Promise<HostSession>;
  locate(run: RunRef): Promise<HostSession | null>;
  message?(session: HostSession, message: string): Promise<void>;
  interrupt?(session: HostSession): Promise<void>;
  focus?(session: HostSession): Promise<void>;
  subagents?(session: HostSession): Promise<readonly HostSession[]>;
  owns_pull_request?(session: HostSession, url: string): Promise<boolean>;
}
