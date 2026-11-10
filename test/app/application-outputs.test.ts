import { expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { run } from "../../src/main.ts";
import { observedValue } from "../../src/domain/gate/evidence.ts";
import { laneResultSchema, laneSchema } from "../../src/domain/lane/lifecycle.ts";
import { shellWord } from "../../src/execution/pickup/launch-prompt.ts";
import { pickupResultSchema } from "../../src/app/pickup/runtime.ts";
import { StateStore } from "../../src/persistence/state.ts";
import type { RuntimeServices } from "../../src/app/runtime-services.ts";
import { GIT_TEST_TIMEOUT_MS } from "../fixtures/git/remote.ts";
import { laneCompleteFixtures } from "../fixtures/lane/complete.ts";
import { catalogEnvelope, pickupFixture } from "../fixtures/pickup/runtime.ts";

const now = "2026-11-05T00:00:00.000Z";

function normalize(value: unknown, replacements: [string, string][]): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item !== "string") return item;
      let text = item.replaceAll("\\", "/");
      for (const [from, to] of replacements) {
        text = text
          .replaceAll(shellWord(from).replaceAll("\\", "/"), to)
          .replaceAll(from.replaceAll("\\", "/"), to);
      }
      return text;
    }),
  );
}

test("snapshot paths normalize mixed Windows separators", () => {
  expect(
    normalize({ path: "C:\\Users\\runneradmin\\Temp\\fixture\\main\\.git\\files" }, [
      ["C:\\Users\\runneradmin\\Temp/fixture", "<root>"],
    ]),
  ).toEqual({ path: "<root>/main/.git/files" });
});

async function command(services: RuntimeServices, args: string[]) {
  const lines: string[] = [];
  const code = await run([...args, "--json"], (line) => lines.push(line), services);
  return { code, output: JSON.parse(lines.join("\n")) as unknown };
}

test(
  "pickup and lane JSON consumed by the T3 skill",
  async () => {
    const f = await pickupFixture();
    try {
      await writeFile(f.t3Catalog, JSON.stringify({ ...catalogEnvelope(), observedAt: now }));
      await mkdir(dirname(f.state), { recursive: true });
      const store = new StateStore(f.state);
      try {
        store.saveUserSetting("reviewers", "correctness");
      } finally {
        store.close();
      }
      const services: RuntimeServices = {
        ...f.services,
        execution: { ...f.services.execution, clock: { now: () => new Date(now) } },
      };
      const args = [
        "pickup",
        "TEST-492",
        "--config",
        f.config,
        "--repo",
        f.remote.alice,
        "--state",
        f.state,
        "--t3-catalog",
        f.t3Catalog,
      ];
      const dry = await command(services, [...args, "--dry-run"]);
      expect(dry.code).toBe(0);
      const plan = pickupResultSchema.parse(dry.output);
      const replacements: [string, string][] = [
        [resolve(import.meta.dirname, "../../src/main.ts"), "<cli>"],
        [`${f.state}.defaults`, "<state>.defaults"],
        [f.state, "<state>"],
        [plan.claimHome.url, "<claim-home-url>"],
        [plan.claimHome.home, "<claim-home>"],
        [plan.claimHome.configCommit, "<config-commit>"],
        [f.root, "<root>"],
      ];
      expect(normalize(dry, replacements)).toMatchSnapshot("pickup planned");
      const defaults = await command(services, [
        "pickup",
        "TEST-492",
        "--config",
        f.config,
        "--repo",
        f.remote.alice,
        "--state",
        `${f.state}.defaults`,
        "--dry-run",
      ]);
      expect(defaults.code).toBe(0);
      const defaultPlan = pickupResultSchema.parse(defaults.output);
      expect(defaultPlan.launch).not.toHaveProperty("modelSelection");
      expect(defaultPlan.launch.message).toContain("calling thread's or project's default");
      expect(normalize(defaults, replacements)).toMatchSnapshot("pickup host defaults");
      const picked = await command(services, args);
      expect(picked.code).toBe(0);
      const claimed = pickupResultSchema.parse(picked.output);
      if (claimed.dryRun) throw new Error("Expected a claimed pickup");
      replacements.unshift([claimed.run, "<run>"], [claimed.claim, "<claim>"]);
      expect(normalize(picked, replacements)).toMatchSnapshot("pickup claimed");
      services.configuration = { cwd: f.worktree };
      const attached = await command(services, ["lane", "attach", "--ticket", claimed.ticket]);
      expect(attached.code).toBe(0);
      const result = laneResultSchema(laneSchema).parse(attached.output);
      if (!result.ok) throw new Error(result.refusal.message);
      const lane = result.value.id;
      replacements.unshift([lane, "<lane>"]);
      expect(normalize(attached, replacements)).toMatchSnapshot("lane attached");
      for (const action of ["show", "next", "list"])
        expect(
          normalize(
            await command(services, ["lane", action, ...(action === "list" ? [] : [lane])]),
            replacements,
          ),
        ).toMatchSnapshot(`lane ${action}`);
      for (const action of ["show", "next", "list"]) {
        const byTicket = await command(services, ["lane", action, "--ticket", "TEST-492"]);
        const byRef = await command(services, [
          "lane",
          action,
          ...(action === "list" ? [] : [lane]),
        ]);
        expect(byTicket).toEqual(byRef);
      }
      for (const action of ["show", "next", "start", "claim", "review", "resume", "complete"]) {
        const missing = await command(services, ["lane", action, "--ticket", "TEST-999"]);
        expect(missing.code).toBe(1);
        expect(missing.output).toMatchObject({ ok: false, refusal: { code: "lane_not_found" } });
        const both = await command(services, ["lane", action, lane, "--ticket", "TEST-492"]);
        expect(both.output).toMatchObject({ ok: false, refusal: { code: "gates_unmet" } });
      }
      const refusal = await command(services, ["lane", "review", lane]);
      expect(refusal.code).toBe(1);
      expect(normalize(refusal, replacements)).toMatchSnapshot("lane refusal");
      services.lane = {
        tracker: {
          read: async () => {
            throw new Error("Unexpected tracker read");
          },
          link_artifact: async () => {},
        },
        artifacts: {
          prepare: async (workspace, head) => ({
            ...workspace,
            head,
            repository: "github.com/test/pickup",
            remote: "https://github.com/test/pickup.git",
          }),
          push: async () => {},
          pullRequests: async () => [],
          open: async (workspace, request) => ({
            url: "https://github.com/test/pickup/pull/940",
            branch: workspace.branch,
            title: request.title,
            state: "OPEN",
          }),
        },
      };
      const head = "a".repeat(40);
      const steps = [
        [
          "submit",
          lane,
          "--head",
          head,
          "--gate",
          "tests",
          "--evidence-url",
          "https://ci.test/940",
        ],
        ["review", lane],
        ["verdict", lane, "--head", head, "--decision", "approved"],
        ["attention", lane, "--reason", "awaiting_merge"],
        ["resume", lane],
      ];
      for (const step of steps) {
        const output = await command(services, [
          "lane",
          String(step[0]),
          "--ticket",
          "TEST-492",
          ...step.slice(2),
        ]);
        expect(output.code).toBe(0);
        expect(normalize(output, replacements)).toMatchSnapshot(`lane ${step[0]}`);
        expect(
          normalize(await command(services, ["lane", "next", lane]), replacements),
        ).toMatchSnapshot(`lane next after ${step[0]}`);
      }
      const secondTicket = "jira:example:TEST:ticket:TEST-493";
      expect((await command(services, ["lane", "create", "--ticket", secondTicket])).code).toBe(0);
      for (const action of ["claim", "start"])
        expect((await command(services, ["lane", action, "--ticket", secondTicket])).code).toBe(0);
      expect((await command(services, ["lane", "list", "--ticket", "TEST-999"])).output).toEqual(
        [],
      );
      const duplicateStore = new StateStore(f.state);
      try {
        duplicateStore.saveLane(
          laneSchema.parse({
            ...duplicateStore.lane(lane),
            id: "interlock-lane:earlier",
            state: "done",
          }),
        );
      } finally {
        duplicateStore.close();
      }
      for (const step of [
        ["show"],
        ["next"],
        ["claim"],
        ["start"],
        ["complete"],
        ...steps.map((step) => [String(step[0]), ...step.slice(2)]),
      ]) {
        const ambiguous = await command(services, ["lane", ...step, "--ticket", "TEST-492"]);
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.output).toMatchObject({ ok: false, refusal: { code: "claim_collision" } });
      }
      expect((await command(services, ["lane", "show", lane])).code).toBe(0);
    } finally {
      await f.dispose();
    }
  },
  GIT_TEST_TIMEOUT_MS,
);

const { mergedLane } = laneCompleteFixtures();

test(
  "lane completion JSON includes read-back unblocked tickets without retirement",
  async () => {
    const f = await mergedLane({ pickedUp: true });
    const completed = await f.complete();
    expect(completed.code).toBe(0);
    const lane = laneResultSchema(laneSchema).parse(completed.result);
    if (!lane.ok) throw new Error(lane.refusal.message);
    expect(
      normalize(completed, [
        [await realpath(f.repo.root), "<root>"],
        [f.repo.root, "<root>"],
        [f.repo.head, "<head>"],
        [lane.value.createdAt, "<time>"],
        [lane.value.updatedAt, "<time>"],
        [f.repo.merge, "<merge>"],
        ...(lane.receipts ?? []).flatMap((receipt): [string, string][] => [
          [receipt.observedAt, "<time>"],
          ...(receipt.gate === "claim_released"
            ? [[observedValue(receipt), "<lock>"] as [string, string]]
            : []),
        ]),
      ]),
    ).toMatchSnapshot();
  },
  GIT_TEST_TIMEOUT_MS,
);
