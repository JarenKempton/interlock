import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { T3Adapter, type T3Receipt, t3Receipt } from "../src/adapters/session-hosts/t3/adapter.ts";
import type { T3Connection } from "../src/adapters/session-hosts/t3/connection.ts";
import { run as runCli } from "../src/cli.ts";
import { actorRefSchema, adapterRefSchema, ticketRefSchema } from "../src/domain/identifiers.ts";
import type { Claim, Run } from "../src/domain/model.ts";
import { LifecycleCoordinator } from "../src/execution/lifecycle.ts";
import { StateStore } from "../src/persistence/state.ts";
import recorded from "./fixtures/t3-snapshot.json";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

const version = "0.0.41-nightly.20260909.1426";
const receipt: T3Receipt = {
  sessionId: "t3:environment-fixture:thread-fixture",
  tier: "managed",
  t3: {
    environmentId: "environment-fixture",
    serverVersion: version,
    threadId: "thread-fixture",
    projectId: "project-fixture",
    workspaceRoot: "/fixture/repo",
    worktreePath: "/fixture/worktree",
    branch: "task/fixture",
    modelSelection: present(recorded.threads[0]).modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
  },
};

function fixture(cleanupOutcome: "pending" | "failed" | "completed" = "pending") {
  const snapshot = structuredClone(recorded);
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const events: Array<{ state: string; evidence: unknown }> = [];
  let closed = 0;
  let unavailable = false;
  let ambiguous = false;
  let settle = true;
  let providerCleanup: "not_requested" | "pending" | "failed" | "completed" = "not_requested";
  const runtime = {
    environmentId: "environment-fixture",
    serverVersion: version,
    origin: "http://127.0.0.1:3773",
  };
  const connection: T3Connection = {
    runtime,
    async request(method, path, body) {
      calls.push({ method, path, ...(body ? { body } : {}) });
      if (method === "GET") return structuredClone(snapshot);
      const command = z.record(z.string(), z.unknown()).parse(body);
      if (settle && command.type === "thread.turn.start") {
        const thread = snapshot.threads[0] ?? structuredClone(present(recorded.threads[0]));
        thread.id = z.string().parse(command.threadId);
        thread.session.threadId = thread.id;
        thread.latestTurn.turnId = "turn-next";
        snapshot.threads = [thread];
        snapshot.snapshotSequence++;
      }
      if (settle && command.type === "thread.session.stop") {
        // Pinned T3 emits session/closed before cleanup and swallows cleanup errors.
        // All three cleanup outcomes therefore expose the same stopped projection.
        snapshot.snapshotSequence++;
        present(snapshot.threads[0]).session.status = "stopped";
        present(snapshot.threads[0]).latestTurn.state = "interrupted";
        providerCleanup = cleanupOutcome;
      }
      if (ambiguous) throw new Error("private response body must not escape");
      return { sequence: snapshot.snapshotSequence };
    },
    async close() {
      closed++;
    },
  };
  const adapter = new T3Adapter({
    connect: async () => {
      if (unavailable) throw new Error("private credential failure");
      return connection;
    },
    journal: async (state, evidence) => {
      events.push({ state, evidence });
    },
    attempts: 2,
    pause: async () => {},
  });
  return {
    adapter,
    snapshot,
    runtime,
    calls,
    events,
    connection,
    unavailable: () => {
      unavailable = true;
    },
    ambiguous: () => {
      ambiguous = true;
    },
    unsettled: () => {
      settle = false;
    },
    closed: () => closed,
    providerCleanup: () => providerCleanup,
  };
}

describe("T3 recorded observation and conformance", () => {
  test("reconnect reads scoped identity and exact reported options without dispatch", async () => {
    const f = fixture();
    const result = await f.adapter.reconnect(receipt);
    expect(result.state).toBe("unknown");
    expect(result.turnState).toBe("completed");
    expect(result.sessionStatus).toBe("ready");
    expect(result.modelSelection).toEqual(receipt.t3.modelSelection);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    expect(f.closed()).toBe(1);
  });

  test.each(["environment", "branch", "path", "project", "duplicate"])(
    "rejects %s identity collision without mutation",
    async (kind) => {
      const f = fixture();
      if (kind === "environment") f.runtime.environmentId = "other";
      if (kind === "branch") present(f.snapshot.threads[0]).branch = "other";
      if (kind === "path") present(f.snapshot.threads[0]).worktreePath = "/other";
      if (kind === "project") present(f.snapshot.projects[0]).workspaceRoot = "/other";
      if (kind === "duplicate")
        f.snapshot.threads.push({ ...present(f.snapshot.threads[0]), id: "collision" });
      const result = await f.adapter.reconnect(receipt);
      expect(result.state).toBe("unknown");
      expect(result.recoveryRequired).toBe(true);
      expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    },
  );

  test("reconnect after a server update validates state and reports the current version without dispatch", async () => {
    const f = fixture();
    f.runtime.serverVersion = "a-later-build";
    expect(await f.adapter.reconnect(receipt)).toMatchObject({
      serverVersion: "a-later-build",
      sessionStatus: "ready",
      recoveryRequired: false,
    });
    expect(receipt.t3.serverVersion).toBe(version);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    expect(f.adapter.capabilities.session_interrupt).toBeUndefined();
  });

  test("an updated server still must supply compatible identity and model state", async () => {
    const f = fixture();
    f.runtime.serverVersion = "a-later-build";
    Object.assign(present(f.snapshot.threads[0]), { modelSelection: { unexpectedSchema: true } });
    expect(await f.adapter.reconnect(receipt)).toMatchObject({
      state: "unknown",
      recoveryRequired: true,
    });
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("bootstrap records the actual server version instead of the planning version", async () => {
    const f = fixture();
    f.runtime.serverVersion = "a-later-build";
    f.snapshot.threads = [];
    const result = await f.adapter.bootstrap({ ...receipt.t3, title: "Fixture", prompt: "Work" });
    expect(result.receipt.t3.serverVersion).toBe("a-later-build");
    expect(result.observation.serverVersion).toBe("a-later-build");
  });

  test.each(["model", "instance", "missing-options", "extra-options", "option-value"])(
    "requires exact %s readback",
    async (kind) => {
      const f = fixture();
      const selection = present(f.snapshot.threads[0]).modelSelection;
      if (kind === "model") selection.model = "other";
      if (kind === "instance") selection.instanceId = "codex-custom";
      if (kind === "missing-options") selection.options = [];
      if (kind === "extra-options") selection.options.push({ id: "context", value: "large" });
      if (kind === "option-value") present(selection.options[0]).value = "low";
      expect((await f.adapter.reconnect(receipt)).recoveryRequired).toBe(true);
      expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    },
  );

  test("missing/unreachable sessions require recovery and preserve the original receipt", async () => {
    const before = structuredClone(receipt);
    const f = fixture();
    f.snapshot.threads = [];
    expect((await f.adapter.reconnect(receipt)).state).toBe("missing");
    f.unavailable();
    const observation = await f.adapter.reconnect(receipt);
    expect(observation.state).toBe("unknown");
    expect(observation.recoveryRequired).toBe(true);
    expect(JSON.stringify(observation)).not.toContain("private");
    expect(receipt).toEqual(before);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test.each(["pending", "failed", "completed"] as const)(
    "stopped projection cannot verify %s provider cleanup",
    async (cleanupOutcome) => {
      const f = fixture(cleanupOutcome);
      await expect(f.adapter.stopSession(receipt)).rejects.toThrow("stop_unverified");
      expect(f.providerCleanup()).toBe(cleanupOutcome);
      expect(await f.adapter.inspect(receipt)).toMatchObject({
        state: "unknown",
        recoveryRequired: true,
        detail: "termination_unverified",
        sessionStatus: "stopped",
        turnState: "interrupted",
      });
      expect(await f.adapter.reconnect(receipt)).toMatchObject({
        state: "unknown",
        recoveryRequired: true,
      });
      expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
      expect(present(f.calls.find((c) => c.method === "POST")).body).toMatchObject({
        type: "thread.session.stop",
        threadId: receipt.t3.threadId,
      });
      expect(present(f.events[0]).state).toBe("t3_dispatch_prepared");
      expect(f.events.some((e) => e.state === "t3_stop_unknown")).toBe(true);
      expect(f.events.some((e) => e.state === "t3_stop_verified")).toBe(false);
    },
  );

  test("lost stop acknowledgement preserves original identity and unknown outcome without retry", async () => {
    const f = fixture();
    f.ambiguous();
    await expect(f.adapter.stopSession(receipt)).rejects.toThrow("stop_unverified");
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const prepared = present(f.events.find((e) => e.state === "t3_dispatch_prepared"));
    const uncertain = present(f.events.find((e) => e.state === "t3_dispatch_unknown"));
    expect(uncertain.evidence).toEqual(prepared.evidence);
  });

  test.each([false, true])(
    "acknowledged/ambiguous stop without readback stays unknown (%s)",
    async (ambiguous) => {
      const f = fixture();
      f.unsettled();
      if (ambiguous) f.ambiguous();
      await expect(f.adapter.stopSession(receipt)).rejects.toThrow("stop_unverified");
      expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
      expect(JSON.stringify(f.events)).not.toContain("private");
    },
  );

  test("persistence failure prevents dispatch", async () => {
    const f = fixture();
    const adapter = new T3Adapter({
      connect: async () => f.connection,
      journal: async () => {
        throw new Error("disk full");
      },
    });
    await expect(adapter.stopSession(receipt)).rejects.toThrow();
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("ambiguous bootstrap retains command identity and never falls back or compensates", async () => {
    const f = fixture();
    f.snapshot.threads = [];
    f.ambiguous();
    await expect(
      f.adapter.bootstrap({
        ...receipt.t3,
        title: "Fixture",
        prompt: "Private instruction",
        threadId: "new-thread",
      }),
    ).rejects.toThrow("dispatch_unknown");
    const dispatches = f.calls.filter((c) => c.method === "POST");
    expect(dispatches).toHaveLength(1);
    expect(present(dispatches[0]).body).toMatchObject({
      type: "thread.turn.start",
      threadId: "new-thread",
    });
    expect(present(f.events[0]).evidence).toEqual(present(f.events[1]).evidence);
    expect(JSON.stringify(f.events)).not.toContain("Private instruction");
  });

  test("bootstrap does not adopt a branch/workspace match with a different thread identity", async () => {
    const f = fixture();
    await expect(
      f.adapter.bootstrap({
        ...receipt.t3,
        title: "Fixture",
        prompt: "Work",
        threadId: "new-thread",
      }),
    ).rejects.toThrow("identity_collision");
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("bootstrap waits for exact selection and a settled turn, then records its receipt", async () => {
    const f = fixture();
    f.snapshot.threads = [];
    const result = await f.adapter.bootstrap({ ...receipt.t3, title: "Fixture", prompt: "Work" });
    expect(result.receipt).toEqual(receipt);
    expect(result.observation.turnId).toBe("turn-next");
    expect(result.observation.state).toBe("unknown");
    expect(result.observation.recoveryRequired).toBe(false);
    expect(present(f.events.at(-1)).state).toBe("t3_bootstrap_observed");
  });

  test("new adapter reconnects an ambiguously committed bootstrap without another turn", async () => {
    const f = fixture();
    f.snapshot.threads = [];
    f.ambiguous();
    await expect(
      f.adapter.bootstrap({ ...receipt.t3, title: "Fixture", prompt: "Work" }),
    ).rejects.toThrow("dispatch_unknown");
    const saved = z
      .object({ receipt: z.unknown().transform(t3Receipt) })
      .parse(JSON.parse(JSON.stringify(present(f.events[0]).evidence)));
    const restarted = new T3Adapter({ connect: async () => f.connection, journal: async () => {} });
    const observed = await restarted.reconnect(saved.receipt);
    expect(observed.turnId).toBe("turn-next");
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("unsettled bootstrap never succeeds from acknowledgement alone", async () => {
    const f = fixture();
    f.snapshot.threads = [];
    f.unsettled();
    await expect(
      f.adapter.bootstrap({ ...receipt.t3, title: "Fixture", prompt: "Work" }),
    ).rejects.toThrow("launch_unverified");
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("project registration settles before bootstrap and never creates a workspace", async () => {
    const f = fixture();
    f.snapshot.projects = [];
    f.snapshot.threads = [];
    const request = f.connection.request;
    f.connection.request = async (method, path, body) => {
      if (z.record(z.string(), z.unknown()).optional().parse(body)?.type === "project.create") {
        f.snapshot.projects = structuredClone(recorded.projects);
      }
      return request(method, path, body);
    };
    await f.adapter.bootstrap({ ...receipt.t3, title: "Fixture", prompt: "Work" });
    const posts = f.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toMatchObject({
      type: "project.create",
      createWorkspaceRootIfMissing: false,
      workspaceRoot: receipt.t3.workspaceRoot,
    });
    expect(posts[1]?.body).toMatchObject({ type: "thread.turn.start" });
  });

  test.each([false, true])(
    "unsettled/ambiguous project registration cannot start a turn (%s)",
    async (ambiguous) => {
      const f = fixture();
      f.snapshot.projects = [];
      f.snapshot.threads = [];
      if (ambiguous) f.ambiguous();
      await expect(
        f.adapter.bootstrap({ ...receipt.t3, title: "Fixture", prompt: "Work" }),
      ).rejects.toThrow(ambiguous ? "dispatch_unknown" : "project_unverified");
      expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    },
  );

  test("wrong launch model is preserved for recovery without deletion or another start", async () => {
    const f = fixture();
    f.snapshot.threads = [];
    const request = f.connection.request;
    f.connection.request = async (method, path, body) => {
      const result = await request(method, path, body);
      if (method === "POST")
        Object.assign(f.snapshot.threads[0]?.modelSelection ?? {}, {
          instanceId: "unexpected-provider",
        });
      return result;
    };
    await expect(
      f.adapter.bootstrap({ ...receipt.t3, title: "Fixture", prompt: "Work" }),
    ).rejects.toThrow("launch_unverified");
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(f.snapshot.threads).toHaveLength(1);
  });

  test("explicit follow-up verifies a different turn; reconnect never calls it", async () => {
    const f = fixture();
    await f.adapter.followUp(receipt, "Next instruction");
    expect(present(f.events.at(-1)).state).toBe("t3_follow_up_observed");
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test.each([false, true])(
    "follow-up preserves uncertainty without retry (%s)",
    async (ambiguous) => {
      const f = fixture();
      f.unsettled();
      if (ambiguous) f.ambiguous();
      await expect(f.adapter.followUp(receipt, "Next")).rejects.toThrow(
        ambiguous ? "dispatch_unknown" : "follow_up_unverified",
      );
      expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    },
  );

  test.each([
    "null-session",
    "null-turn",
    "unknown-enum",
    "active-turn",
    "last-error",
    "provider-instance",
    "stale",
    "malformed",
  ])("contradictory/incomplete %s evidence never verifies stop", async (kind) => {
    const f = fixture();
    const thread = present(f.snapshot.threads[0]);
    if (kind === "null-session") Object.assign(thread, { session: null });
    if (kind === "null-turn") Object.assign(thread, { latestTurn: null });
    if (kind === "unknown-enum") thread.session.status = "future-status";
    if (kind === "active-turn") Object.assign(thread.session, { activeTurnId: "wrong-turn" });
    if (kind === "last-error") Object.assign(thread.session, { lastError: "private failure" });
    if (kind === "provider-instance") thread.session.providerInstanceId = "other";
    if (kind === "malformed") Object.assign(f.snapshot, { snapshotSequence: "3421" });
    if (kind === "stale") {
      f.unsettled();
      f.connection.request = async (method) =>
        method === "POST" ? { sequence: 9999 } : structuredClone(f.snapshot);
    }
    await expect(f.adapter.stopSession(receipt)).rejects.toThrow();
    if (kind !== "stale") expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("running is observed only with consistent turn/session identity", async () => {
    const f = fixture();
    Object.assign(present(f.snapshot.threads[0]).session, {
      status: "running",
      activeTurnId: "turn-fixture",
    });
    present(f.snapshot.threads[0]).latestTurn.state = "running";
    expect((await f.adapter.inspect(receipt)).state).toBe("running");
    await expect(f.adapter.followUp(receipt, "do not queue")).rejects.toThrow("session_not_ready");
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("already-stopped projection remains unknown without another dispatch", async () => {
    const f = fixture();
    present(f.snapshot.threads[0]).session.status = "stopped";
    await expect(f.adapter.stopSession(receipt)).rejects.toThrow("stop_unverified");
    expect(await f.adapter.inspect(receipt)).toMatchObject({
      state: "unknown",
      recoveryRequired: true,
      detail: "termination_unverified",
    });
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("runtime validation rejects array-valued modes before connecting", async () => {
    const f = fixture();
    const malformed = structuredClone(receipt);
    Object.assign(malformed.t3, { runtimeMode: ["full-access"] });
    await expect(f.adapter.stopSession(malformed)).rejects.toThrow("invalid_identity");
    expect(f.calls).toHaveLength(0);
  });

  test("missing deletion metadata cannot hide a workspace collision", async () => {
    const f = fixture();
    Reflect.deleteProperty(present(f.snapshot.threads[0]), "deletedAt");
    await expect(
      f.adapter.bootstrap({ ...receipt.t3, threadId: "new", title: "Fixture", prompt: "Work" }),
    ).rejects.toThrow("invalid_snapshot");
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  test("reconnect journals only validated receipt fields", async () => {
    const f = fixture();
    await f.adapter.reconnect(
      Object.assign({}, receipt, { unrelatedConversation: "private-data" }),
    );
    expect(JSON.stringify(f.events)).not.toContain("private-data");
  });

  test("describe and lifecycle do not advertise unverified interruption", async () => {
    const f = fixture();
    expect((await f.adapter.describe()).capabilities.session_interrupt).toBeUndefined();
    expect(f.adapter.capabilities.session_interrupt).toBeUndefined();
    expect(f.adapter.lifecycle().capabilities.session_interrupt).toBeUndefined();
  });
});

test.each(["projected-stopped", "unverified", "missing", "unavailable"])(
  "existing lifecycle/store refuses unqualified stop and preserves workspace/claim for %s",
  async (outcome) => {
    const directory = mkdtempSync(join(tmpdir(), "t3-conformance-"));
    const marker = join(directory, "keep.txt");
    writeFileSync(marker, "keep");
    const store = new StateStore(join(directory, "state.db"));
    try {
      const f = fixture();
      const savedReceipt = structuredClone(receipt);
      savedReceipt.t3.worktreePath = directory;
      present(f.snapshot.threads[0]).worktreePath = directory;
      const run: Run = {
        ref: "interlock-run:t3",
        ticket: ticketRefSchema.parse("jira:fixture"),
        harness: adapterRefSchema.parse("t3"),
        workspace: { path: directory, branch: receipt.t3.branch },
        capabilities: f.adapter.capabilities,
        status: "active",
        createdAt: "2026-09-10T00:00:00Z",
        updatedAt: "2026-09-10T00:00:00Z",
        execution: savedReceipt,
      };
      const claim: Claim = {
        ref: "interlock-claim:t3",
        ticket: run.ticket,
        humanOwner: actorRefSchema.parse("jaren"),
        run: run.ref,
        previousState: { version: "1", payload: {} },
        claimedAt: run.createdAt,
        leaseExpiresAt: "2026-09-11T00:00:00Z",
        status: "active",
      };
      store.saveRun(run);
      store.saveClaim(claim);
      const adapter = new T3Adapter({
        connect: async () => {
          if (outcome === "unavailable") throw new Error("offline");
          return f.connection;
        },
        journal: async (state, evidence) => {
          store.recordStep(run.ref, state, evidence);
        },
        attempts: 2,
        pause: async () => {},
      });
      const lifecycle = adapter.lifecycle();
      if (outcome === "projected-stopped")
        present(f.snapshot.threads[0]).session.status = "stopped";
      if (outcome === "unverified") f.unsettled();
      if (outcome === "missing") f.snapshot.threads = [];
      const coordinator = new LifecycleCoordinator(store, undefined, () => lifecycle, {
        now: () => new Date(),
      });
      await expect(coordinator.stop(run.ref)).rejects.toThrow("session_interrupt");
      // Capability preflight cannot claim a stop happened or mutate an active run.
      expect(store.run(run.ref)).toEqual(run);
      await expect(lifecycle.stop(run)).rejects.toThrow("session_interrupt");
      expect(f.calls).toHaveLength(0);
      expect(store.claim(claim.ref)).toEqual(claim);
      expect(store.run(run.ref).execution).toEqual(savedReceipt);
      expect(existsSync(marker)).toBe(true);
      if (outcome === "missing")
        expect((await lifecycle.observe(store.run(run.ref))).state).toBe("unknown");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each([{ options: [] }, { options: ["--live"] }, { options: ["--read-only", "extra"] }])(
  "CLI T3 refuses lifecycle or ambiguous options %j",
  async ({ options }) => {
    await expect(runCli(["adapter", "test", "t3", ...options], () => {})).rejects.toThrow(
      options.length
        ? "Invalid arguments"
        : "For T3, this command supports read-only discovery only",
    );
  },
);
