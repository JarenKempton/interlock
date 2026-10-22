import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { z } from "zod";
import { GitClaimLock, heldClaim } from "../src/adapters/claims/git-lock.ts";
import { JiraTrackerAdapter } from "../src/adapters/trackers/jira.ts";
import { createApplication } from "../src/application.ts";
import { ClaimCollisionError } from "../src/domain/contracts.ts";
import {
  actorRefSchema,
  claimRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../src/domain/identifiers.ts";
import { ClaimCoordinator } from "../src/execution/claims.ts";
import { journalJiraWrite, verifyJournaledJiraWrite } from "../src/execution/jira-write-journal.ts";
import { StateStore } from "../src/persistence/state.ts";
import { GIT_TEST_TIMEOUT_MS } from "./fixtures/git-remote.ts";
import { pickupFixture } from "./fixtures/pickup-runtime.ts";

const ticket = ticketRefSchema.parse("jira:example:TEST:ticket:TEST-492");

test.each([
  ["resume", "assignment", "predecessor"],
  ["restore", "assignment", "predecessor"],
  ["resume", "assignment", "successor"],
  ["restore", "assignment", "successor"],
  ["resume", "phase", "predecessor"],
  ["restore", "phase", "predecessor"],
  ["resume", "legacy", "predecessor"],
  ["restore", "legacy", "predecessor"],
])(
  "interrupted successor %s after %s readback preserves %s ownership across restart",
  async (operation, interruption, remainingOwner) => {
    const f = await pickupFixture();
    let store: StateStore | undefined;
    try {
      const picked = await createApplication(f.services).pickup.execute(f.input);
      if (!("claim" in picked)) throw new Error("Expected claim");
      store = new StateStore(f.state);
      const initial = store.claim(picked.claim);
      const run = runRefSchema.parse("interlock-run:successor");
      const owner = actorRefSchema.parse("bob");
      store.saveRun({ ...store.run(picked.run), ref: run, status: "planning" });
      const lock = new GitClaimLock({
        repository: f.remote.alice,
        remote: "origin",
        git: f.git,
        clock: { now: () => new Date(Date.parse(initial.leaseExpiresAt) + 1) },
      });
      const successor = {
        ticket,
        claim: claimRefSchema.parse("interlock-claim:successor"),
        run,
        owner,
        expectedVersion: (await lock.read(ticket)).version,
        leaseExpiresAt: new Date(Date.parse(initial.leaseExpiresAt) + 900_000).toISOString(),
        staleClaim: initial.ref,
        authorizedBy: initial.humanOwner,
        originalSnapshot: initial.previousState,
      };
      const mirror = () =>
        new JiraTrackerAdapter({
          instance: "example",
          workspace: "TEST",
          transport: f.jira,
          journalWrite(pending) {
            if (!store) throw new Error("Missing journal");
            return journalJiraWrite(store, run, pending);
          },
        });
      let readFailed = false;
      let assignmentEvidence: unknown;
      f.jira.fail = (method, path, after) => {
        if (method === "PUT" && path.endsWith("/assignee") && !after)
          assignmentEvidence = {
            property: structuredClone(f.jira.property),
            pending: store?.pendingWrite(run)?.receipt,
          };
        if (
          !readFailed &&
          method === "GET" &&
          (interruption === "phase"
            ? path.includes("/properties/") &&
              z.object({ assignmentPhase: z.string() }).safeParse(f.jira.property).data
                ?.assignmentPhase === "started"
            : path.includes("/issue/TEST-492?") &&
              f.jira.issue.fields.assignee?.accountId === owner)
        ) {
          readFailed = true;
          throw new Error("Assignment readback connection lost");
        }
      };
      await expect(new ClaimCoordinator(lock, mirror()).reclaim(successor)).rejects.toThrow();
      expect(readFailed).toBe(true);
      expect(f.jira.issue.fields.assignee?.accountId).toBe(
        interruption === "phase" ? initial.humanOwner : owner,
      );
      if (interruption === "phase") expect(assignmentEvidence).toBeUndefined();
      else
        expect(assignmentEvidence).toMatchObject({
          property: { assignmentPhase: "started" },
          pending: { pendingJiraWrite: { expected: { field: "assignee", value: owner } } },
        });
      expect(store.pendingWrite(run)).toBeUndefined();
      const held = await lock.read(ticket);
      f.jira.fail = undefined;
      if (remainingOwner === "predecessor")
        f.jira.issue.fields.assignee = { accountId: initial.humanOwner };
      if (interruption === "legacy") {
        const { assignmentPhase: _, ...legacy } = z
          .record(z.string(), z.unknown())
          .parse(f.jira.property);
        f.jira.property = legacy;
      }
      store.close();
      store = new StateStore(f.state);
      const restarted = mirror();
      await verifyJournaledJiraWrite(store, run, ticket, restarted);
      const writes = () =>
        f.jira.calls.filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call));
      const before = writes();
      const attempt = () =>
        operation === "resume"
          ? restarted.apply({ ...successor, supersedes: initial.ref })
          : new ClaimCoordinator(lock, restarted).restoreClaimState({
              ticket,
              claim: successor.claim,
              claimedOwner: owner,
              originalSnapshot: initial.previousState,
            });
      if (remainingOwner === "predecessor") {
        await expect(attempt()).rejects.toBeInstanceOf(ClaimCollisionError);
        expect(writes()).toEqual(before);
        expect(f.jira.issue.fields.assignee?.accountId).toBe(initial.humanOwner);
        expect((await lock.read(ticket)).version).toBe(held.version);
      } else {
        await attempt();
        if (operation === "resume") {
          await new ClaimCoordinator(lock, restarted).verifyReclaimed(successor);
          expect(f.jira.property).toEqual({
            claim: successor.claim,
            run,
            owner,
            supersedes: initial.ref,
          });
          expect((await lock.read(ticket)).version).toBe(held.version);
        } else {
          expect(f.jira.property).toBeNull();
          expect(f.jira.issue.fields.assignee).toBeNull();
          expect((await lock.read(ticket)).record?.action).toBe("release");
        }
      }
    } finally {
      store?.close();
      await f.dispose();
    }
  },
  GIT_TEST_TIMEOUT_MS,
);

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
      await expect(
        createApplication(f.services).claim.release.execute({ claim: picked.claim }),
      ).rejects.toThrow("Unfinished legacy release requires recovery");
      expect(
        f.jira.calls.slice(calls).filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call)),
      ).toEqual([]);
      expect(
        heldClaim(
          await new GitClaimLock({ repository: f.remote.alice, remote: "origin", git: f.git }).read(
            ticket,
          ),
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
          resolve("test/fixtures/pickup-http-command.ts"),
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
          pendingJiraWrite: { ticket, expected: { field: field === "property" ? "claim" : field } },
        });
        expect(store.recoveryEvidence(picked.run)).toHaveLength(0);
      } finally {
        store.close();
      }
      const lock = new GitClaimLock({ repository: f.remote.alice, remote: "origin", git: f.git });
      const writes = f.jira.calls.filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call));
      await expect(
        createApplication(f.services).claim.release.execute({ claim: picked.claim }),
      ).rejects.toThrow("requires recovery");
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
      server.stop(true);
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
      await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toMatchObject({
        receipt: { state: stage === "intent" ? "compensated" : "recovery_required" },
      });
      const lock = new GitClaimLock({ repository: f.remote.alice, remote: "origin", git: f.git });
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
