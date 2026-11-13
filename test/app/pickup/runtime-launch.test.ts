import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createApplication } from "../../../src/app/application.ts";
import { StateStore } from "../../../src/persistence/state.ts";
import { checkedGit, GIT_TEST_TIMEOUT_MS } from "../../fixtures/git/remote.ts";
import { inspect, lock, pickupRuntimeFixtures, ref } from "../../fixtures/pickup/runtime-suite.ts";
import { rejection } from "../../fixtures/assertions/rejection.ts";
import { launchable } from "../../fixtures/host/scripted-t3.ts";
import { updateUserSettings } from "../../../src/configuration/store.ts";

const fixture = pickupRuntimeFixtures();

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function title(f: Fixture) {
  const planned = await createApplication(f.services).pickup.execute({
    ...f.input,
    "t3-catalog": undefined,
    "dry-run": true,
  });
  return planned.title;
}

test(
  "--launch claims, then starts one T3 thread on the fetched base commit and adopts its worktree",
  async () => {
    const f = await fixture();
    expect(await title(f)).toBe("TEST-492: Prepare a real pickup");
    const { t3, input } = launchable(f);
    const result = await createApplication(f.services).pickup.execute(input);
    const base = await checkedGit(
      f.remote.git,
      ["rev-parse", "refs/remotes/origin/main"],
      f.remote.alice,
    );
    const start = t3.calls.find((call) => call[1] === "start") ?? [];
    expect(start.slice(0, 9)).toEqual([
      "thread",
      "start",
      join(f.root, basename(f.remote.alice)),
      "-",
      "--title",
      "🔨 TEST-492: Prepare a real pickup",
      "--worktree",
      base,
      "--branch",
    ]);
    expect(t3.calls.filter((call) => call[1] === "start")).toHaveLength(1);
    expect(t3.calls.findIndex((call) => call[0] === "--version")).toBe(0);
    expect(result).toMatchObject({
      state: "claimed",
      worktree: join(f.root, "t3-worktrees", "TEST-492"),
      session: {
        id: "thread-1",
        environment: "env-1",
        harness: "claudeAgent",
        branch: "task/TEST-492",
        worktree: join(f.root, "t3-worktrees", "TEST-492"),
      },
    });
    const run = inspect(f, (store) => store.listRuns()[0]);
    expect(run?.workspace).toEqual({
      path: join(f.root, "t3-worktrees", "TEST-492"),
      branch: "task/TEST-492",
      ticket: ref,
    });
    const attached = await createApplication(f.services).lane.attach.execute({
      ticket: ref,
      worktree: join(f.root, "t3-worktrees", "TEST-492"),
      state: f.state,
    });
    expect(attached).toMatchObject({ ok: true, value: { state: "implementing" } });
    if (result.dryRun || !("value" in attached)) throw new Error("expected a claimed lane");
    expect(result.session?.lane).toBe(attached.value.id);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "--launch hands configured reviewer targets to the lane instead of a human review",
  async () => {
    const f = await fixture();
    mkdirSync(dirname(f.state), { recursive: true });
    const store = new StateStore(f.state);
    updateUserSettings(store, (settings) => ({
      ...settings,
      reviewers: "correctness",
      reviewer_harness: "claudeAgent",
      reviewer_model: "claude-sonnet-5-5",
      reviewer_effort: "high",
    }));
    store.close();
    const { t3, input } = launchable(f);
    await createApplication(f.services).pickup.execute({ ...input, state: f.state });
    expect(t3.prompt).toContain(
      'correctness: target {"providerInstanceId":"claudeAgent","model":"claude-sonnet-5-5","options":{"effort":"high"}}',
    );
    expect(t3.prompt).toContain("--reason reviewer_unavailable");
    expect(t3.prompt).not.toContain("review_required");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "an incompatible t3 CLI refuses before any claim or launch",
  async () => {
    const f = await fixture();
    const { t3, input } = launchable(f);
    t3.version = "t3 v0.1.6\n";
    expect(
      (await rejection(createApplication(f.services).pickup.execute(input))).message,
    ).toContain("host_incompatible");
    expect(t3.calls.some((call) => call[1] === "start")).toBe(false);
    expect((await lock(f).read(ref)).version).toBe("absent");
    expect(f.jira.property).toBeNull();
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "an existing task branch on origin refuses before any claim",
  async () => {
    const f = await fixture();
    const { t3, input } = launchable(f);
    await checkedGit(
      f.remote.git,
      ["push", "--quiet", "origin", "main:task/TEST-492"],
      f.remote.alice,
    );
    expect(
      (await rejection(createApplication(f.services).pickup.execute(input))).message,
    ).toContain("branch_exists: Branch task/TEST-492 already exists");
    expect(t3.calls.some((call) => call[1] === "start")).toBe(false);
    expect((await lock(f).read(ref)).version).toBe("absent");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "exit 0 without a readable thread keeps the claim, requires recovery and never relaunches",
  async () => {
    const f = await fixture();
    const { t3, input } = launchable(f);
    t3.start = "silent";
    expect(
      (await rejection(createApplication(f.services).pickup.execute(input))).message,
    ).toContain("Pickup ended in recovery_required");
    expect(t3.calls.filter((call) => call[1] === "start")).toHaveLength(1);
    expect(inspect(f, (store) => store.listRuns()[0]?.status)).toBe("recovery_required");
    expect((await lock(f).read(ref)).record?.action).not.toBe("release");
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "a failed start with no thread and no branch is proven not launched and compensates",
  async () => {
    const f = await fixture();
    const { t3, input } = launchable(f);
    t3.start = "fail";
    expect(
      (await rejection(createApplication(f.services).pickup.execute(input))).message,
    ).toContain("Pickup ended in compensated");
    expect(t3.calls.filter((call) => call[1] === "start")).toHaveLength(1);
    expect(inspect(f, (store) => store.listRuns()[0]?.status)).toBe("compensated");
  },
  GIT_TEST_TIMEOUT_MS,
);
