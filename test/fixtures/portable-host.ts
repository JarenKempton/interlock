import type { HostFixture } from "../../src/conformance/host.ts";
import { AmbiguousTrackerResultError, ClaimCollisionError } from "../../src/domain/contracts.ts";
import {
  HOST_CAPABILITIES,
  type Host,
  type HostCapabilities,
  type HostSession,
} from "../../src/domain/host.ts";
import { fakePlanningTicket } from "./configuration-plan.ts";

export function fakeHostFixture(): HostFixture {
  const sessions: HostSession[] = [];
  const messages: string[] = [];
  const children: HostSession[] = [];
  let focused: string | null = null;
  let failReadback = false;
  const ownedPullRequest = "https://example.invalid/pull/1";
  const request = {
    run: "interlock-run:conformance" as const,
    ticket: fakePlanningTicket,
    workspace: { path: "/work/conformance", branch: "task/T-1" },
  };
  const capabilities: HostCapabilities = {};
  for (const capability of HOST_CAPABILITIES) capabilities[capability] = true;
  const adapter: Host = {
    async describe() {
      return capabilities;
    },
    async launch(input) {
      const existing = sessions.find((session) => session.run === input.run);
      if (existing) {
        if (
          existing.ticket !== input.ticket.ref ||
          existing.workspace.path !== input.workspace.path ||
          existing.workspace.branch !== input.workspace.branch
        )
          throw new ClaimCollisionError();
        return structuredClone(existing);
      }
      const session: HostSession = {
        id: `session-${sessions.length + 1}`,
        run: input.run,
        ticket: input.ticket.ref,
        workspace: input.workspace,
        state: "running",
      };
      sessions.push(structuredClone(session));
      children.push({ ...session, id: "child-1", run: "interlock-run:child" });
      if (failReadback) throw new AmbiguousTrackerResultError();
      return session;
    },
    async locate(run) {
      return structuredClone(sessions.find((session) => session.run === run) ?? null);
    },
    async message(_session, text) {
      messages.push(text);
    },
    async interrupt(session) {
      const current = sessions.find((item) => item.id === session.id);
      if (current) current.state = "stopped";
    },
    async focus(session) {
      focused = session.id;
    },
    async subagents() {
      return structuredClone(children);
    },
    async owns_pull_request(_session, url) {
      return url === ownedPullRequest;
    },
  };
  return {
    adapter,
    request,
    ownedPullRequest,
    unrelatedPullRequest: "https://example.invalid/pull/2",
    observe: async () => structuredClone({ sessions, messages, children, focused }),
    loseLaunchReadback: () => {
      failReadback = true;
    },
  };
}
