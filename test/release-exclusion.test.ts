import { expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { GitClaimLock, heldClaim } from "../src/adapters/claims/git-lock.ts";
import { createApplication } from "../src/application.ts";
import { normalizeClaimHome } from "../src/domain/claim-home.ts";
import { ticketRefSchema } from "../src/domain/identifiers.ts";
import { StateStore } from "../src/persistence/state.ts";
import { GIT_TEST_TIMEOUT_MS } from "./fixtures/git-remote.ts";
import { pickupFixture } from "./fixtures/pickup-runtime.ts";

test.each(["complete", "kill"])(
  "release excludes competing attempts during reads and unlocks after %s",
  async (outcome) => {
    const f = await pickupFixture();
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let intercepted = false;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { method, path, body } = z
          .object({ method: z.string(), path: z.string(), body: z.unknown().optional() })
          .parse(await request.json());
        const response = await f.jira.request(method, path, body);
        if (!intercepted && method === "GET" && path.endsWith("/transitions")) {
          intercepted = true;
          paused.resolve();
          await resume.promise;
        }
        return Response.json(response);
      },
    });
    try {
      const app = createApplication(f.services);
      const first = await app.pickup.execute(f.input);
      if (!("claim" in first)) throw new Error("Expected claim");
      const alias = join(f.root, "state-alias");
      await symlink(dirname(f.state), alias, "junction");
      child = Bun.spawn(
        [
          process.execPath,
          resolve("test/fixtures/pickup-http-command.ts"),
          "claim",
          "release",
          first.claim,
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
      const timer = setTimeout(() => paused.reject(new Error("No paused release read")), 10_000);
      try {
        await paused.promise;
      } finally {
        clearTimeout(timer);
      }
      const store = new StateStore(f.state);
      try {
        expect(store.pendingWrite(first.run)).toBeUndefined();
        const calls = [...f.jira.calls];
        await expect(
          app.claim.release.execute({ claim: first.claim, state: join(alias, basename(f.state)) }),
        ).rejects.toThrow("Another pickup or release is using this ledger");
        expect(f.jira.calls).toEqual(calls);
        expect(store.run(first.run).status).toBe("claimed");
        expect(store.recoveryEvidence(first.run)).toHaveLength(0);
        expect((await app.runs.list.execute({}))[0]?.status).toBe("claimed");
        if (outcome === "kill") {
          child.kill("SIGKILL");
          await child.exited;
          expect((await app.claim.release.execute({ claim: first.claim })).state).toBe("released");
        } else {
          resume.resolve();
          expect(await child.exited).toBe(0);
          if (!child.stdout || typeof child.stdout === "number")
            throw new Error("Expected release output stream");
          expect(JSON.parse(await new Response(child.stdout).text()).state).toBe("released");
        }
        const successor = await app.pickup.execute(f.input);
        if (!("claim" in successor)) throw new Error("Expected successor claim");
        resume.resolve();
        await expect(app.claim.release.execute({ claim: first.claim })).rejects.toThrow(
          "Claim lock changed",
        );
        const lock = new GitClaimLock({
          repository: f.remote.alice,
          home: normalizeClaimHome(f.remote.remote),
          git: f.git,
        });
        expect(heldClaim(await lock.read(ticketRefSchema.parse(first.ticket)))?.claim).toBe(
          successor.claim,
        );
        expect(f.jira.issue.fields.status.name).toBe("In Progress");
        expect(f.jira.issue.fields.assignee).toEqual({ accountId: "test-owner" });
        expect(f.jira.property).toMatchObject({ claim: successor.claim, run: successor.run });
        expect(store.run(successor.run).status).toBe("claimed");
        expect(store.run(first.run).status).toBe("released");
      } finally {
        store.close();
      }
    } finally {
      resume.resolve();
      if (child?.exitCode === null) child.kill("SIGKILL");
      if (child) await child.exited;
      server.stop(true);
      await f.dispose();
    }
  },
  GIT_TEST_TIMEOUT_MS,
);
