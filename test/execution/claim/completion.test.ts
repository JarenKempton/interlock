import { expect, test } from "bun:test";
import { GitClaimLock } from "../../../src/adapters/git/claim-lock.ts";
import { createApplication } from "../../../src/app/application.ts";
import { normalizeClaimHome } from "../../../src/domain/claim/home.ts";
import { ticketRefSchema } from "../../../src/domain/refs/identifiers.ts";
import { StateStore } from "../../../src/persistence/state.ts";
import { checkedGit, GIT_TEST_TIMEOUT_MS } from "../../fixtures/git/remote.ts";
import { pickupFixture } from "../../fixtures/pickup/runtime.ts";

test(
  "claim release recovers a retirement fence without restoring Done or its assignee",
  async () => {
    const f = await pickupFixture();
    try {
      const app = createApplication(f.services);
      const picked = await app.pickup.execute(f.input);
      if (!("claim" in picked)) throw new Error("Expected claim");
      const ticket = ticketRefSchema.parse("jira:example:TEST:ticket:TEST-492");
      const lock = new GitClaimLock({
        repository: f.remote.alice,
        home: normalizeClaimHome(f.remote.remote),
        git: f.git,
      });
      const before = await lock.read(ticket);
      const fenced = await checkedGit(
        f.git,
        [
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@invalid",
          "commit-tree",
          await checkedGit(f.git, ["mktree"], f.remote.alice),
          "-p",
          before.version,
          "-m",
          "retirement",
          "-m",
          JSON.stringify({ ...before.record, claim: "interlock-claim:retirement-old" }),
        ],
        f.remote.alice,
      );
      await checkedGit(
        f.git,
        ["push", f.remote.remote, `${fenced}:${await lock.ref(ticket)}`],
        f.remote.alice,
      );
      f.jira.issue.fields.status = { name: "Done", statusCategory: { key: "done" } };
      const assignee = f.jira.issue.fields.assignee;
      const result = await app.claim.release.execute({ claim: picked.claim });
      expect(result.mirror).toBe("removed_verified");
      expect(f.jira.issue.fields.status.name).toBe("Done");
      expect(f.jira.issue.fields.assignee).toEqual(assignee);
      expect(f.jira.property).toBeNull();
      const after = await lock.read(ticket);
      expect(after.record).toMatchObject({
        action: "release",
        claim: "interlock-claim:retirement-old",
      });
      expect(await checkedGit(f.git, ["rev-parse", `${after.version}^`], f.remote.alice)).toBe(
        fenced,
      );
      expect((await app.claim.release.execute({ claim: picked.claim })).mirror).toBe(
        "removed_verified",
      );
      expect(await lock.read(ticket)).toEqual(after);
      const store = new StateStore(f.state);
      try {
        expect(store.run(picked.run).status).toBe("released");
        expect(store.claim(picked.claim).status).toBe("released");
      } finally {
        store.close();
      }
    } finally {
      await f.dispose();
    }
  },
  GIT_TEST_TIMEOUT_MS,
);
