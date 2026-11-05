import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { heldClaim } from "../src/adapters/claims/git-lock.ts";
import { createApplication } from "../src/application.ts";
import { normalizeClaimHome } from "../src/domain/claim-home.ts";
import type { Claim } from "../src/domain/model.ts";
import { StateStore } from "../src/persistence/state.ts";
import { GIT_TEST_TIMEOUT_MS } from "./fixtures/git-remote.ts";
import {
  configure,
  configureUserHome,
  homeLock,
  inspect,
  lock,
  pickupRuntimeFixtures,
  ref,
} from "./fixtures/pickup-runtime-suite.ts";

const fixture = pickupRuntimeFixtures();

test(
  "release refuses another actor before writes and recovers after a lost release receipt",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const result = await app.pickup.execute(f.input);
    if (!("claim" in result)) throw new Error("Expected claim");
    f.jira.owner = "someone-else";
    await expect(app.claim.release.execute({ claim: result.claim })).rejects.toThrow(
      "recorded claim owner",
    );
    expect(heldClaim(await lock(f).read(ref))).toBeDefined();
    f.jira.owner = "test-owner";
    class FailingStore extends StateStore {
      override commitRelease() {
        throw new Error("commit failed");
      }
    }
    f.services.execution = { ...f.services.execution, openStore: (path) => new FailingStore(path) };
    await expect(
      createApplication(f.services).claim.release.execute({ claim: result.claim }),
    ).rejects.toThrow("requires recovery");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    delete f.services.execution.openStore;
    expect(
      (await createApplication(f.services).claim.release.execute({ claim: result.claim })).state,
    ).toBe("released");
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each(["property", "assignment", "transition"])(
  "a delayed Jira %s release write blocks restart retries until it completes",
  async (stage) => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claim");
    const request = f.jira.request.bind(f.jira);
    let finish: (() => Promise<unknown>) | undefined;
    f.jira.request = async (method, path, body) => {
      if (
        !finish &&
        ((stage === "property" && method === "DELETE" && path.includes("/properties/")) ||
          (stage === "assignment" && method === "PUT" && path.endsWith("/assignee")) ||
          (stage === "transition" && method === "POST" && path.endsWith("/transitions")))
      ) {
        finish = () => request(method, path, body);
        throw new Error("Accepted restoration remains pending");
      }
      return request(method, path, body);
    };
    await expect(app.claim.release.execute({ claim: picked.claim })).rejects.toThrow(
      "requires recovery",
    );
    const writes = f.jira.calls.filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call));
    await expect(
      createApplication(f.services).claim.release.execute({ claim: picked.claim }),
    ).rejects.toThrow("requires recovery");
    expect(f.jira.calls.filter((call) => /^(PUT|DELETE) |^POST .*transitions/.test(call))).toEqual(
      writes,
    );
    expect(heldClaim(await lock(f).read(ref))?.claim).toBe(picked.claim);
    expect(inspect(f, (s) => s.run(picked.run)).status).toBe("recovery_required");
    if (!finish) throw new Error("Expected pending Jira write");
    await finish();
    expect(
      (await createApplication(f.services).claim.release.execute({ claim: picked.claim })).state,
    ).toBe("released");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(f.jira.property).toBeNull();
    expect(f.jira.issue.fields.assignee).toBeNull();
    expect(f.jira.issue.fields.status.name).toBe("To Do");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release mirror failure retains lock and can be retried after readback",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    let failed = false;
    f.jira.fail = (method, path, after) => {
      if (!failed && after && method === "DELETE" && path.includes("/properties/")) {
        failed = true;
        throw new Error("release response lost");
      }
    };
    await expect(app.claim.release.execute({ claim: picked.claim })).rejects.toThrow(
      "requires recovery",
    );
    expect(heldClaim(await lock(f).read(ref))?.claim).toBe(picked.claim);
    expect(inspect(f, (s) => s.run(picked.run)).status).toBe("recovery_required");
    expect((await app.claim.release.execute({ claim: picked.claim })).state).toBe("released");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(existsSync(f.worktree)).toBe(true);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release uses the recorded repository, site and claimed status after shared config changes",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    await writeFile(f.config, '[statuses]\nclaimed = "Elsewhere"\n');
    expect((await app.claim.release.execute({ claim: picked.claim })).state).toBe("released");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release restores a claimed ticket even after its parent map is removed",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    Reflect.deleteProperty(f.jira.issue.fields, "parent");
    expect(
      (await f.git.run(["git", "branch", "-m", "main", "renamed-base"], f.remote.alice)).exitCode,
    ).toBe(0);
    expect((await app.claim.release.execute({ claim: picked.claim })).state).toBe("released");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(f.jira.property).toBeNull();
    expect(f.jira.issue.fields.assignee).toBeNull();
    expect(f.jira.issue.fields.status.name).toBe("To Do");
    expect(existsSync(f.worktree)).toBe(true);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release rejects repository origin drift before writing Jira or the lock",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    const calls = f.jira.calls.length;
    f.services.execution = {
      ...f.services.execution,
      git: {
        async run(argv, cwd) {
          if (argv.join(" ") === "git remote get-url origin")
            return { exitCode: 0, stdout: "https://github.com/other/repository.git", stderr: "" };
          return f.git.run(argv, cwd);
        },
      },
    };
    await expect(app.claim.release.execute({ claim: picked.claim })).rejects.toThrow(
      "Repository origin mismatch",
    );
    expect(heldClaim(await lock(f).read(ref))?.claim).toBe(picked.claim);
    expect(f.jira.calls.slice(calls).every((call) => call.startsWith("GET "))).toBe(true);
    expect(f.jira.issue.fields.status.name).toBe("In Progress");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release needs no Rank or map discovery",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    Reflect.deleteProperty(f.jira.issue.fields, "parent");
    Reflect.deleteProperty(f.jira.issue.fields, "customfield_rank");
    f.jira.fail = (_method, path) => {
      if (["/rest/api/3/field", "/rest/api/3/search/jql"].includes(path))
        throw new Error("pickup discovery unavailable");
    };
    expect((await app.claim.release.execute({ claim: picked.claim })).state).toBe("released");
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(f.jira.property).toBeNull();
    expect(f.jira.issue.fields.assignee).toBeNull();
    expect(f.jira.issue.fields.status.name).toBe("To Do");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release refuses a rewritten claim home push before restoring Jira",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claimed plan");
    const other = join(f.root, "other.git");
    expect((await f.git.run(["git", "init", "--bare", "--quiet", other], f.root)).exitCode).toBe(0);
    await configure(f, `url.${other}.pushInsteadOf`, f.remote.remote);
    const before = f.jira.calls.length;
    await expect(app.claim.release.execute({ claim: picked.claim })).rejects.toThrow(
      `claim home ${normalizeClaimHome(f.remote.remote).identity}`,
    );
    expect(f.jira.calls.slice(before).every((call) => call.startsWith("GET "))).toBe(true);
    expect(f.jira.property).toMatchObject({ claim: picked.claim });
    expect(f.jira.issue.fields.status.name).toBe("In Progress");
    await configure(f, "--unset", `url.${other}.pushInsteadOf`);
    expect(heldClaim(await lock(f).read(ref))?.claim).toBe(picked.claim);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "release uses the saved claim home even after the configured home changes",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claim");
    const other = join(f.root, "other.git");
    expect((await f.git.run(["git", "init", "--bare", "--quiet", other], f.root)).exitCode).toBe(0);
    await writeFile(join(f.remote.alice, "interlock.toml"), `claim_home = '${other}'\n`);
    for (const argv of [
      ["add", "interlock.toml"],
      ["-c", "user.name=F", "-c", "user.email=f@invalid", "commit", "-m", "move home"],
      ["push", "--quiet", "origin", "main"],
    ])
      expect((await f.git.run(["git", ...argv], f.remote.alice)).exitCode).toBe(0);
    await configureUserHome(f, other);
    await app.claim.release.execute({ claim: picked.claim, state: f.state });
    expect((await lock(f).read(ref)).record?.action).toBe("release");
    expect((await homeLock(f, other).read(ref)).version).toBe("absent");
    expect(f.jira.property).toBeNull();
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each([
  [
    "before claim homes",
    (claim: Claim): Claim => {
      const { claimHome: _, claimHomeUrl: __, lockRef: ___, ...v1 } = claim;
      return v1;
    },
    "was made before claim homes; remove the interlock.claim property from TEST-492 and refs/interlock/claims/TEST-492 from the claim remote",
  ],
  [
    "by a newer Interlock",
    (claim: Claim): Claim => ({ ...claim, recordVersion: 3 }),
    "has record version 3; upgrade Interlock to release it",
  ],
])(
  "release refuses a claim recorded %s without touching Jira or the lock",
  async (_, recorded, message) => {
    const f = await fixture();
    const app = createApplication(f.services);
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claim");
    const before = await lock(f).read(ref);
    inspect(f, (s) => {
      s.saveClaim(recorded(s.claimForRun(picked.run)));
    });
    const calls = f.jira.calls.length;
    await expect(
      app.claim.release.execute({ claim: picked.claim, state: f.state }),
    ).rejects.toThrow(message);
    expect(f.jira.calls.length).toBe(calls);
    expect(await lock(f).read(ref)).toEqual(before);
  },
  GIT_TEST_TIMEOUT_MS,
);
