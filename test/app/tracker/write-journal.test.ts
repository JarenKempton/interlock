import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { z } from "zod";
import { GitClaimLock } from "../../../src/adapters/git/claim-lock.ts";
import { heldClaim } from "../../../src/domain/claim/lock.ts";
import { createApplication } from "../../../src/app/application.ts";
import { normalizeClaimHome } from "../../../src/domain/claim/home.ts";
import { ticketRefSchema } from "../../../src/domain/refs/identifiers.ts";
import { StateStore } from "../../../src/persistence/state.ts";
import { journaledWrite } from "../../../src/app/tracker/write-journal.ts";
import { GIT_TEST_TIMEOUT_MS } from "../../fixtures/git/remote.ts";
import { pickupFixture } from "../../fixtures/pickup/runtime.ts";
import { expectRejection } from "../../fixtures/assertions/rejection.ts";

const ticket = ticketRefSchema.parse("jira:example:TEST:ticket:TEST-492");

test(
  "write journal connections cannot replace pending intent or complete a successor",
  async () => {
    const f = await pickupFixture();
    try {
      const picked = await createApplication(f.services).pickup.execute(f.input);
      if (!("run" in picked)) throw new Error("Expected run");
      const first = new StateStore(f.state);
      const second = new StateStore(f.state);
      try {
        const id = first.beginWrite(picked.run, { operation: "first" });
        expect(() => second.beginWrite(picked.run, { operation: "competing" })).toThrow(
          "unfinished write",
        );
        expect(second.pendingWrite(picked.run)).toEqual({ id, receipt: { operation: "first" } });
        expect(() => second.completeWrite(picked.run, id + 1)).toThrow("Pending write changed");
        first.completeWrite(picked.run, id);
        const next = second.beginWrite(picked.run, { operation: "next" });
        expect(() => first.completeWrite(picked.run, id)).toThrow("Pending write changed");
        expect(first.pendingWrite(picked.run)?.id).toBe(next);
        second.completeWrite(picked.run, next);
        expect(first.pendingWrite(picked.run)).toBeUndefined();
      } finally {
        first.close();
        second.close();
      }
    } finally {
      await f.dispose();
    }
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "unfinished release without a write journal cannot silently retry",
  async () => {
    const f = await pickupFixture();
    try {
      const picked = await createApplication(f.services).pickup.execute(f.input);
      if (!("run" in picked)) throw new Error("Expected run");
      const store = new StateStore(f.state);
      try {
        store.recordStep(picked.run, "releasing", { claim: picked.claim });
      } finally {
        store.close();
      }
      const calls = f.jira.calls.length;
      await expectRejection(
        createApplication(f.services).claim.release.execute({ claim: picked.claim }),
      ).toThrow("Unfinished legacy release requires recovery");
      expect(
        f.jira.calls.slice(calls).filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call)),
      ).toEqual([]);
      expect(
        heldClaim(
          await new GitClaimLock({
            repository: f.remote.alice,
            home: normalizeClaimHome(f.remote.remote),
            git: f.git,
          }).read(ticket),
        )?.claim,
      ).toBe(picked.claim);
    } finally {
      await f.dispose();
    }
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each(["status", "assignee", "property"])(
  "a killed release preserves pending Jira %s intent and blocks retry until readback",
  async (field) => {
    const f = await pickupFixture();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const accepted = Promise.withResolvers<void>();
    const responseGate = Promise.withResolvers<void>();
    let finish: (() => Promise<unknown>) | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { method, path, body } = z
          .object({ method: z.string(), path: z.string(), body: z.unknown().optional() })
          .parse(await request.json());
        if (
          !finish &&
          ((field === "status" && method === "POST" && path.endsWith("/transitions")) ||
            (field === "assignee" && method === "PUT" && path.endsWith("/assignee")) ||
            (field === "property" && method === "DELETE" && path.includes("/properties/")))
        ) {
          finish = () => f.jira.request(method, path, body);
          accepted.resolve();
          await responseGate.promise;
          return Response.json({ status: 204 });
        }
        return Response.json(await f.jira.request(method, path, body));
      },
    });
    try {
      const picked = await createApplication(f.services).pickup.execute(f.input);
      if (!("claim" in picked)) throw new Error("Expected claim");
      child = Bun.spawn(
        [
          process.execPath,
          resolve("test/fixtures/pickup/http-command.ts"),
          "claim",
          "release",
          picked.claim,
          "--state",
          f.state,
          "--json",
        ],
        {
          env: {
            ...process.env,
            INTERLOCK_TEST_ROOT: f.root,
            INTERLOCK_TEST_ENDPOINT: server.url.href,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timeout = setTimeout(
        () => accepted.reject(new Error("No accepted Jira write")),
        10_000,
      );
      try {
        await accepted.promise;
      } finally {
        clearTimeout(timeout);
      }
      child.kill("SIGKILL");
      await child.exited;
      const store = new StateStore(f.state);
      try {
        expect(store.pendingWrite(picked.run)?.receipt).toMatchObject({
          pendingTrackerWrite: {
            ticket,
            expected: { field: field === "property" ? "claim" : field },
          },
        });
        expect(store.recoveryEvidence(picked.run)).toHaveLength(0);
      } finally {
        store.close();
      }
      const lock = new GitClaimLock({
        repository: f.remote.alice,
        home: normalizeClaimHome(f.remote.remote),
        git: f.git,
      });
      const writes = f.jira.calls.filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call));
      await expectRejection(
        createApplication(f.services).claim.release.execute({ claim: picked.claim }),
      ).toThrow("requires recovery");
      expect(
        f.jira.calls.filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call)),
      ).toEqual(writes);
      expect(heldClaim(await lock.read(ticket))?.claim).toBe(picked.claim);
      if (!finish) throw new Error("Expected pending Jira write");
      await finish();
      expect(
        (await createApplication(f.services).claim.release.execute({ claim: picked.claim })).state,
      ).toBe("released");
      const successor = await createApplication(f.services).pickup.execute(f.input);
      if (!("claim" in successor)) throw new Error("Expected successor claim");
      expect(heldClaim(await lock.read(ticket))?.claim).toBe(successor.claim);
      expect(f.jira.issue.fields.status.name).toBe("In Progress");
      expect(f.jira.property).toMatchObject({ claim: successor.claim });
    } finally {
      if (child?.exitCode === null) child.kill("SIGKILL");
      if (child) await child.exited;
      responseGate.resolve();
      void server.stop(true);
      await f.dispose();
    }
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each(["intent", "completion"])(
  "Jira write journal %s failure never permits unverified release",
  async (stage) => {
    const f = await pickupFixture();
    class FailingStore extends StateStore {
      override recordStep(...args: Parameters<StateStore["recordStep"]>) {
        if (args[1] === (stage === "intent" ? "write_pending" : "write_completed"))
          throw new Error("Journal unavailable");
        super.recordStep(...args);
      }
    }
    f.services.execution = { ...f.services.execution, openStore: (path) => new FailingStore(path) };
    try {
      await expectRejection(createApplication(f.services).pickup.execute(f.input)).toMatchObject({
        receipt: { state: stage === "intent" ? "compensated" : "recovery_required" },
      });
      const lock = new GitClaimLock({
        repository: f.remote.alice,
        home: normalizeClaimHome(f.remote.remote),
        git: f.git,
      });
      if (stage === "intent") {
        expect(
          f.jira.calls.filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call)),
        ).toEqual([]);
        expect(heldClaim(await lock.read(ticket))).toBeUndefined();
      } else {
        expect(heldClaim(await lock.read(ticket))).toBeDefined();
        expect(f.jira.property).not.toBeNull();
      }
    } finally {
      await f.dispose();
    }
  },
  GIT_TEST_TIMEOUT_MS,
);

test("a journaled write recorded under the pre-registry key is still recovered", () => {
  const pending = { ticket: "jira:example:TEST:ticket:TEST-492", operation: "assign issue" };
  expect(journaledWrite({ pendingJiraWrite: pending })).toEqual(pending);
  expect(journaledWrite({ pendingTrackerWrite: pending })).toEqual(pending);
  expect(journaledWrite({ operation: "release" })).toBeUndefined();
});
