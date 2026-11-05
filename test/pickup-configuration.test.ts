import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { heldClaim } from "../src/adapters/claims/git-lock.ts";
import { createApplication } from "../src/application.ts";
import { readUserSettings } from "../src/configuration/local-settings.ts";
import { configurationOperations } from "../src/configuration/project-files.ts";
import { normalizeClaimHome } from "../src/domain/claim-home.ts";
import { StateStore } from "../src/persistence/state.ts";
import { checkedGit, GIT_TEST_TIMEOUT_MS } from "./fixtures/git-remote.ts";
import { catalogEnvelope } from "./fixtures/pickup-runtime.ts";
import {
  configure,
  configureUserHome,
  first,
  homeLock,
  inspect,
  lock,
  pickupRuntimeFixtures,
  ref,
} from "./fixtures/pickup-runtime-suite.ts";

const fixture = pickupRuntimeFixtures();

test.each(["remote-read", "commit-preparation"])(
  "catalog expiry during final %s prevents the claim push",
  async (stage) => {
    const f = await fixture();
    const catalog = catalogEnvelope();
    await writeFile(f.t3Catalog, JSON.stringify(catalog));
    const observed = Date.parse(catalog.observedAt);
    let now = observed;
    let claiming = false;
    class ClaimingStore extends StateStore {
      override recordStep(...args: Parameters<StateStore["recordStep"]>) {
        super.recordStep(...args);
        if (args[1] === "claiming") claiming = true;
      }
    }
    let pushes = 0;
    f.services.execution = {
      ...f.services.execution,
      clock: { now: () => new Date(now) },
      openStore: (path) => new ClaimingStore(path),
      git: {
        async run(argv, cwd) {
          if (argv[1] === "push") pushes += 1;
          const result = await f.git.run(argv, cwd);
          if (
            (stage === "remote-read" && claiming && argv[1] === "ls-remote") ||
            (stage === "commit-preparation" && argv.includes("commit-tree"))
          )
            now = observed + 60_001;
          return result;
        },
      },
    };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow("catalog");
    expect(now).toBe(observed + 60_001);
    expect(pushes).toBe(0);
    expect(heldClaim(await lock(f).read(ref))).toBeUndefined();
    expect(f.jira.property).toBeNull();
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each(["stale", "missing", "ambiguous", "disabled", "option"])(
  "invalid %s catalog selection fails before tracker or ledger access",
  async (failure) => {
    const f = await fixture();
    const catalog = catalogEnvelope();
    if (failure === "stale") catalog.observedAt = "2000-01-01T00:00:00.000Z";
    if (failure === "missing") first(catalog.catalog.providers).models = [];
    if (failure === "ambiguous") catalog.catalog.providers.push(first(catalog.catalog.providers));
    if (failure === "disabled") first(catalog.catalog.providers).canRunChildTask = false;
    if (failure === "option") first(catalog.catalog.inheritedOptions).value = "unsupported";
    await writeFile(f.t3Catalog, JSON.stringify(catalog));
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow();
    expect(f.jira.calls).toEqual([]);
    expect(existsSync(f.state)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "catalog expiry during preflight prevents the first remote claim write",
  async () => {
    const f = await fixture();
    const envelope = catalogEnvelope();
    await writeFile(f.t3Catalog, JSON.stringify(envelope));
    let now = Date.parse(envelope.observedAt);
    const git = f.git;
    f.services.execution = {
      ...f.services.execution,
      clock: { now: () => new Date(now) },
      git: {
        async run(argv, cwd) {
          const result = await git.run(argv, cwd);
          if (argv[1] === "ls-remote") now += 60_001;
          return result;
        },
      },
    };
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      "catalog is stale",
    );
    expect((await lock(f).read(ref)).version).toBe("absent");
    expect(f.jira.property).toBeNull();
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "an unavailable requested host fails before Jira access or any state change",
  async () => {
    const f = await fixture();
    await setUser(f, "host", "unavailable");
    const before = await readFile(f.state);
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      "Requested host is unavailable",
    );
    expect(f.jira.calls).toEqual([]);
    expect((await readFile(f.state)).equals(before)).toBe(true);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "pickup refuses a rewritten claim home push without leaving a claim in either remote",
  async () => {
    const f = await fixture();
    const other = join(f.root, "other.git");
    expect((await f.git.run(["git", "init", "--bare", "--quiet", other], f.root)).exitCode).toBe(0);
    await configure(f, `url.${other}.pushInsteadOf`, f.remote.remote);
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      `claim home ${normalizeClaimHome(f.remote.remote).identity}`,
    );
    await configure(f, "--unset", `url.${other}.pushInsteadOf`);
    for (const remote of [f.remote.remote, other])
      expect((await homeLock(f, remote).read(ref)).version).toBe("absent");
    expect(f.jira.property).toBeNull();
    expect(existsSync(f.worktree)).toBe(false);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "pickup prints the claim home and saves it from the first verified claim, never a dry run",
  async () => {
    const f = await fixture();
    const app = createApplication(f.services);
    const home = normalizeClaimHome(f.remote.remote);
    const planned = await app.pickup.execute({ ...f.input, "dry-run": true });
    expect(planned.claimHome).toMatchObject({
      home: home.identity,
      url: home.url,
      source: expect.stringContaining("claim_home in interlock.toml on refs/heads/main at "),
      change: expect.stringContaining("interlock config edit --set claim-home VALUE"),
      lockRef: "refs/interlock/v2/example/TEST-492",
      recordVersion: 2,
    });
    expect(readUserSettings(f.state).claim_home).toBeUndefined();
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected claim");
    expect(picked.claimHomeSaved).toBe(true);
    expect(readUserSettings(f.state).claim_home).toBe(home.url);
    const target = {
      claimHome: home.identity,
      claimHomeUrl: home.url,
      recordVersion: 2,
      lockRef: "refs/interlock/v2/example/TEST-492",
      configCommit: planned.claimHome.configCommit,
    };
    expect(inspect(f, (s) => s.claimForRun(picked.run))).toMatchObject(target);
    const claiming = z
      .object({ state: z.string(), receipt_json: z.string() })
      .array()
      .parse(inspect(f, (s) => s.steps(picked.run)))
      .find((step) => step.state === "claiming");
    expect(JSON.parse(claiming?.receipt_json ?? "null").receipt).toMatchObject(target);
    expect(heldClaim(await lock(f).read(ref))).toMatchObject({ home: home.identity, version: 2 });
    expect(f.jira.property).toMatchObject({ home: home.identity, version: 2 });
    await app.claim.release.execute({ claim: picked.claim, state: f.state });
    await configureUserHome(f, "someone/else");
    expect(readUserSettings(f.state).claim_home).toBe("https://github.com/someone/else.git");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "an existing claim-home setting is never overwritten by a claim",
  async () => {
    const f = await fixture();
    await configureUserHome(f, "someone/else");
    const picked = await createApplication(f.services).pickup.execute(f.input);
    expect(picked).toMatchObject({ claimHomeSaved: false });
    expect(readUserSettings(f.state).claim_home).toBe("https://github.com/someone/else.git");
  },
  GIT_TEST_TIMEOUT_MS,
);

async function setUser(
  f: Awaited<ReturnType<typeof fixture>>,
  name: "host" | "branch" | "pickable_statuses" | "claimed_status" | "jira_site",
  value: string,
) {
  await configurationOperations({ cwd: f.root, statePath: f.state }).edit({
    path: f.config,
    set: [name, value],
  });
}

test(
  "pickup runs in the current repo with no interlock.toml, using the signed-in Jira site",
  async () => {
    const f = await fixture();
    await setUser(f, "jira_site", "https://example.atlassian.net");
    await rm(join(f.remote.alice, "interlock.toml"));
    f.services.configuration = { cwd: f.remote.alice };
    Reflect.deleteProperty(f.jira.issue.fields, "parent");
    const result = await createApplication(f.services).pickup.execute({
      key: "TEST-492",
      state: f.state,
      "t3-catalog": f.t3Catalog,
      "dry-run": true,
    });
    expect(result).toMatchObject({
      state: "planned",
      repository: "alice",
      branch: "task/TEST-492",
      worktree: f.worktree,
    });
    expect(result.prompt).not.toContain("Map:");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "pickup from a linked worktree plans against the main checkout",
  async () => {
    const f = await fixture();
    const linked = join(f.root, "linked");
    await checkedGit(
      f.git,
      ["worktree", "add", "--quiet", "-b", "side", linked, "main"],
      f.remote.alice,
    );
    const result = await createApplication(f.services).pickup.execute({
      ...f.input,
      repo: linked,
      "dry-run": true,
    });
    expect(result).toMatchObject({ repository: "alice", worktree: f.worktree });
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "pickup without a Jira site names login and the user setting",
  async () => {
    const f = await fixture();
    await writeFile(f.config, "version = 2\n");
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toThrow(
      "run interlock login jira or interlock config edit --set jira_site URL",
    );
    expect(f.jira.calls).toEqual([]);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a branch template or --branch names the branch, which is recorded for the run",
  async () => {
    const f = await fixture();
    await setUser(f, "branch", "feature/{key}-work");
    const app = createApplication(f.services);
    const planned = await app.pickup.execute({ ...f.input, "dry-run": true });
    expect(planned.branch).toBe("feature/TEST-492-work");
    const picked = await app.pickup.execute({ ...f.input, branch: "fix/TEST-492" });
    if (!("run" in picked)) throw new Error("Expected a claimed plan");
    expect(picked.launch.workspaceStrategy.branch).toBe("fix/TEST-492");
    expect(inspect(f, (s) => s.run(picked.run)).workspace.branch).toBe("fix/TEST-492");
    expect((await f.git.run(["git", "branch", "--show-current"], f.worktree)).stdout.trim()).toBe(
      "fix/TEST-492",
    );
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each([
  ["fix/other", "must contain TEST-492"],
  ["bad..TEST-492", "not a valid Git branch name"],
])(
  "--branch %s is refused before tracker access",
  async (branch, message) => {
    const f = await fixture();
    await expect(
      createApplication(f.services).pickup.execute({ ...f.input, branch }),
    ).rejects.toThrow(message);
    expect(f.jira.calls).toEqual([]);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "shared statuses override user statuses, which override the defaults",
  async () => {
    const f = await fixture();
    f.jira.issue.fields.status.name = "Ready";
    const app = createApplication(f.services);
    await expect(app.pickup.execute({ ...f.input, "dry-run": true })).rejects.toThrow(
      "unassigned ticket in To Do",
    );
    await setUser(f, "pickable_statuses", "Ready, To Do");
    expect((await app.pickup.execute({ ...f.input, "dry-run": true })).state).toBe("planned");
    await writeFile(
      f.config,
      `${await readFile(f.config, "utf8")}[statuses]\npickable = ["To Do"]\nclaimed = "Doing"\n`,
    );
    await expect(app.pickup.execute({ ...f.input, "dry-run": true })).rejects.toThrow(
      "unassigned ticket in To Do",
    );
    f.jira.issue.fields.status.name = "To Do";
    const picked = await app.pickup.execute(f.input);
    if (!("claim" in picked)) throw new Error("Expected a claimed plan");
    expect(f.jira.issue.fields.status.name).toBe("Doing");
    expect((await app.claim.release.execute({ claim: picked.claim })).state).toBe("released");
    expect(f.jira.issue.fields.status.name).toBe("To Do");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a reviewer setting without reviewers refuses before any claim, workspace or tracker change",
  async () => {
    const f = await fixture();
    await configurationOperations({ cwd: f.root, statePath: f.state }).edit({
      set: ["reviewer_model", "review-model"],
    });
    await expect(createApplication(f.services).pickup.execute(f.input)).rejects.toMatchObject({
      code: "reviewers_unset",
      message: expect.stringContaining("reviewer_model is set but reviewers is empty"),
    });
    expect(f.jira.calls).toEqual([]);
    expect((await lock(f).read(ref)).version).toBe("absent");
    expect(existsSync(f.worktree)).toBe(false);
    expect(inspect(f, (s) => s.listRuns())).toEqual([]);
  },
  GIT_TEST_TIMEOUT_MS,
);
