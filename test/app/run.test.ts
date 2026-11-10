import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApplication } from "../../src/application.ts";
import { StateStore } from "../../src/persistence/state.ts";
import { GIT_TEST_TIMEOUT_MS } from "../fixtures/git-remote.ts";
import { inspect, pickupRuntimeFixtures, ref } from "../fixtures/pickup-runtime-suite.ts";
import { launchable } from "../fixtures/scripted-t3.ts";

const fixture = pickupRuntimeFixtures();

async function supervised() {
  const f = await fixture();
  mkdirSync(dirname(f.state), { recursive: true });
  const store = new StateStore(f.state);
  store.updateUserSettings((settings) => ({
    ...settings,
    jira_site: "https://example.atlassian.net",
  }));
  store.close();
  const { t3 } = launchable(f);
  const tick = () =>
    createApplication(f.services).run.execute({
      project: `TEST-470=${f.remote.alice}`,
      once: true,
      state: f.state,
    });
  const starts = () => t3.calls.filter((call) => call[1] === "start");
  return { f, tick, starts };
}

test(
  "run --once picks up and launches an unblocked frontier ticket, and a restart never relaunches it",
  async () => {
    const { f, tick, starts } = await supervised();

    const first = await tick();
    expect(first).toMatchObject({
      launched: [{ ticket: ref, session: "thread-1" }],
      failures: [],
    });
    expect(starts()).toHaveLength(1);
    const lane = inspect(f, (store) => store.laneForTicket(ref));
    expect(lane?.state).toBe("queued");
    expect(inspect(f, (store) => store.listRuns().map((run) => [run.ticket, run.status]))).toEqual([
      [ref, "claimed"],
    ]);

    const restarted = await tick();
    expect(restarted).toMatchObject({ launched: [], failures: [] });
    expect(starts()).toHaveLength(1);

    const status = await createApplication(f.services).status.execute({ state: f.state });
    expect(status).toEqual([
      expect.objectContaining({
        ticket: ref,
        gates: [
          expect.objectContaining({
            gate: "frontier",
            fact: "blockers_closed",
            source: { system: "jira", ref },
            observed: { value: true },
          }),
        ],
      }),
    ]);
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "parallelism counts launched lanes before they attach",
  async () => {
    const { f, starts } = await supervised();
    f.jira.relatedIssues.push({
      ...structuredClone(f.jira.issue),
      key: "TEST-493",
      fields: { ...structuredClone(f.jira.issue.fields), customfield_rank: "0|b:" },
    });
    const run = (parallelism: string) =>
      createApplication(f.services).run.execute({
        project: `TEST-470=${f.remote.alice}`,
        once: true,
        parallelism,
        state: f.state,
      });

    expect(await run("1")).toMatchObject({ launched: [{ ticket: ref }] });
    expect(await run("1")).toMatchObject({ launched: [] });
    expect(starts()).toHaveLength(1);
  },
  GIT_TEST_TIMEOUT_MS,
);
