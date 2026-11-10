import { describe, expect, test } from "bun:test";
import {
  type HostCapability,
  HostLaunchUnresolvedError,
  type HostLaunchResult,
  type HostRecoveryResult,
  HostRefusal,
  type HostSession,
} from "../../../src/domain/host/capability.ts";
import {
  adapterRefSchema,
  laneRefSchema,
  mapRefSchema,
  ticketRefSchema,
} from "../../../src/domain/refs/identifiers.ts";
import type { Ticket } from "../../../src/domain/model.ts";
import { HostLaunchWorkspace } from "../../../src/execution/pickup/host-launch.ts";
import { rejection } from "../../fixtures/assertions/rejection.ts";

const lane = laneRefSchema.parse("interlock-lane:one");
const ticketRef = ticketRefSchema.parse("jira:acme:W:ticket:W-1");
const ticket: Ticket = {
  ref: ticketRef,
  map: mapRefSchema.parse("jira:acme:W:map:M"),
  kind: "task",
  state: "open",
  status: "To Do",
  order: 0,
};
const session: HostSession = {
  environment: "env-1",
  host: adapterRefSchema.parse("t3"),
  harness: adapterRefSchema.parse("claudeAgent"),
  session: "thread-1",
  lane,
  ticket: ticketRef,
};
const bound = { path: "/t3/worktrees/W-1", branch: "task/W-1" };
const launched: HostLaunchResult = {
  state: "launched",
  session,
  view: { session, status: "running", workspace: bound, messages: [] },
};

class FakeHost implements HostCapability<string> {
  readonly calls: string[] = [];
  launchResult: HostLaunchResult | Error = launched;
  recoverResult: HostRecoveryResult | Error = { state: "not_launched", evidence: "nothing" };

  async preflight() {
    this.calls.push("preflight");
  }
  async launch() {
    this.calls.push("launch");
    if (this.launchResult instanceof Error) throw this.launchResult;
    return this.launchResult;
  }
  async find() {
    return [];
  }
  async read() {
    return launched.state === "launched" ? launched.view : Promise.reject(new Error("unreachable"));
  }
  async steer() {
    return { state: "delivered" as const };
  }
  async recover() {
    this.calls.push("recover");
    if (this.recoverResult instanceof Error) throw this.recoverResult;
    return this.recoverResult;
  }
}

function subject(host = new FakeHost(), failing?: string) {
  const records: string[] = [];
  const workspace = new HostLaunchWorkspace({
    workspace: {
      preflight: async () => {
        records.push("workspace_preflight");
      },
      plan: async () => ({ ticket: ticketRef, path: "/canonical/W-1", branch: "task/W-1" }),
    },
    host,
    plan: "plan",
    operation: [lane, "launch"],
    record: (state) => {
      if (state === failing) throw new Error("ledger unavailable");
      records.push(state);
    },
  });
  return { host, records, workspace };
}

const plan = { ticket: ticketRef, path: "", branch: "task/W-1" };

describe("host launch workspace", () => {
  test("preflights the workspace and the host before any claim", async () => {
    const { host, records, workspace } = subject();
    await workspace.preflight(ticket);
    expect(records).toEqual(["workspace_preflight"]);
    expect(host.calls).toEqual(["preflight"]);
  });

  test("leaves the path to the host and adopts the bound worktree", async () => {
    const { host, records, workspace } = subject();
    expect(await workspace.plan(ticket)).toEqual(plan);
    expect(await workspace.prepare(plan)).toEqual({ ...bound, ticket: ticketRef });
    expect(records).toEqual(["host_launching", "host_launched"]);
    expect(host.calls).toEqual(["launch"]);
    expect(workspace.launched?.session.session).toBe("thread-1");
  });

  test("an ambiguous launch adopts a session recovery finds", async () => {
    const host = new FakeHost();
    host.launchResult = {
      state: "ambiguous",
      reason: "exit 0 without a thread",
      acknowledged: true,
    };
    host.recoverResult = { state: "found", session, view: launched.view };
    const { workspace } = subject(host);
    expect(await workspace.prepare(plan)).toEqual({ ...bound, ticket: ticketRef });
    expect(host.calls).toEqual(["launch", "recover"]);
  });

  test("proven non-launch fails so pickup can compensate", async () => {
    const host = new FakeHost();
    host.launchResult = {
      state: "ambiguous",
      reason: "t3 thread start failed: the project has no default model",
      acknowledged: false,
    };
    const { workspace } = subject(host);
    const error = await workspace.prepare(plan).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HostLaunchUnresolvedError);
    expect(error).toMatchObject({
      message:
        "Host launch did not start a session: t3 thread start failed: the project has no default model; nothing",
    });
    expect(host.calls).toEqual(["launch", "recover"]);
  });

  test("a launch the host acknowledged but recovery cannot find stays unresolved", async () => {
    const host = new FakeHost();
    host.launchResult = { state: "ambiguous", reason: "exit 0", acknowledged: true };
    const { workspace } = subject(host);
    expect((await rejection(workspace.prepare(plan))).message).toContain(
      "The host reported a launch that recovery cannot find: exit 0; nothing",
    );
  });

  test("an unresolved launch is never compensated or launched again", async () => {
    const host = new FakeHost();
    host.launchResult = { state: "ambiguous", reason: "thread failed", acknowledged: true };
    host.recoverResult = { state: "ambiguous", reason: "branch exists without a thread" };
    const { workspace } = subject(host);
    expect(await rejection(workspace.prepare(plan))).toBeInstanceOf(HostLaunchUnresolvedError);
    expect((await rejection(workspace.prepare(plan))).message).toContain("already attempted");
    expect(host.calls).toEqual(["launch", "recover"]);
  });

  test("a recovery that repeats the launch reason reports it once", async () => {
    const host = new FakeHost();
    host.launchResult = { state: "ambiguous", reason: "thread ended failed", acknowledged: true };
    host.recoverResult = { state: "ambiguous", reason: "thread ended failed" };
    const { workspace } = subject(host);
    expect((await rejection(workspace.prepare(plan))).message).toBe(
      "Host launch is unresolved: thread ended failed",
    );
  });

  test("a launch that throws after starting is recovered, not compensated", async () => {
    const host = new FakeHost();
    host.launchResult = new Error("T3 server is not reachable");
    host.recoverResult = new Error("still unreachable");
    const { workspace } = subject(host);
    expect((await rejection(workspace.prepare(plan))).message).toContain(
      "Host launch is unresolved: T3 server is not reachable; still unreachable",
    );
  });

  test("a branch refusal before starting is not a launch", async () => {
    const host = new FakeHost();
    host.launchResult = new HostRefusal("branch_exists", "Branch task/W-1 already exists");
    const { workspace } = subject(host);
    expect(await rejection(workspace.prepare(plan))).toBeInstanceOf(HostRefusal);
    expect(host.calls).toEqual(["launch"]);
  });

  test("a session that cannot be recorded is unresolved, not compensated", async () => {
    const { workspace } = subject(new FakeHost(), "host_launched");
    const error = await rejection(workspace.prepare(plan));
    expect(error).toBeInstanceOf(HostLaunchUnresolvedError);
    expect(error.message).toContain("thread-1 started but could not be recorded");
  });

  test("any host refusal from launch happens before a side effect and is not recovered", async () => {
    const host = new FakeHost();
    host.launchResult = new HostRefusal("host_unavailable", "Cannot verify branch task/W-1");
    const { workspace } = subject(host);
    expect(await rejection(workspace.prepare(plan))).toBeInstanceOf(HostRefusal);
    expect(host.calls).toEqual(["launch"]);
  });

  test("a session bound to another branch is unresolved", async () => {
    const host = new FakeHost();
    host.launchResult = {
      ...launched,
      view: { ...launched.view, workspace: { ...bound, branch: "t3/abc" } },
    } as HostLaunchResult;
    const { workspace } = subject(host);
    expect(await rejection(workspace.prepare(plan))).toBeInstanceOf(HostLaunchUnresolvedError);
  });
});
