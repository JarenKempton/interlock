import type { PreparedWorkspace, RunRef, Ticket, TicketRef } from "./model.ts";

export type HostCapability = "message" | "interrupt" | "focus" | "subagents" | "pr_ownership";
export type HostCapabilities = Partial<Record<HostCapability, true>>;

interface LaunchRequest {
  run: RunRef;
  ticket: Ticket;
  workspace: PreparedWorkspace;
  model?: string;
  effort?: string;
  context?: string;
}

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
