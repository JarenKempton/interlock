import { describe, expect, test } from "bun:test";
import { claimLockConformance } from "../src/conformance/claim-lock.ts";
import { hostConformance } from "../src/conformance/host.ts";
import { runConformance } from "../src/conformance/runner.ts";
import { trackerConformance } from "../src/conformance/tracker.ts";
import { ticketRefSchema } from "../src/domain/identifiers.ts";
import { fakeHostFixture } from "./fixtures/portable-host.ts";
import { fakeLockFixture } from "./fixtures/portable-lock.ts";
import { fakeTrackerFixture } from "./fixtures/portable-tracker.ts";

describe("portable adapter conformance", () => {
  test("fake tracker, lock and host pass the executable contract", async () => {
    const report = await runConformance([
      ...trackerConformance(async () => fakeTrackerFixture()),
      ...claimLockConformance(async () => fakeLockFixture()),
      ...hostConformance(async () => fakeHostFixture()),
    ]);
    expect(report.results.filter((result) => !result.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.results.length).toBe(25);
  });

  test.each(["collision", "stale", "ambiguous"] as const)(
    "rejects a lock that lies about %s guarantees",
    async (fault) => {
      const report = await runConformance(claimLockConformance(async () => fakeLockFixture(fault)));
      expect(report.ok).toBe(false);
      expect(
        report.results.some(
          (result) =>
            !result.ok && result.name.includes(fault === "stale" ? "stale_version" : fault),
        ),
      ).toBe(true);
    },
  );

  test("rejects a lock that corrupts the stored run or lease", async () => {
    const report = await runConformance(
      claimLockConformance(async () => {
        const fixture = fakeLockFixture();
        const read = fixture.adapter.read;
        fixture.adapter.read = async (ticket) => {
          const state = await read(ticket);
          if (state.record)
            state.record = {
              ...state.record,
              run: "interlock-run:corrupt",
              leaseExpiresAt: "2000-01-01T00:00:00Z",
            };
          return state;
        };
        return fixture;
      }),
    );
    expect(report.results.find((result) => result.name === "claim_lock.collision")).toMatchObject({
      ok: false,
    });
    expect(
      report.results.find((result) => result.name === "claim_lock.stale_version"),
    ).toMatchObject({ ok: false });
  });

  test.each(["drop_artifacts", "reject_successor"] as const)(
    "rejects tracker %s regression",
    async (fault) => {
      const report = await runConformance(
        trackerConformance(async () => fakeTrackerFixture(fault)),
      );
      expect(
        report.results.find(
          (result) =>
            result.name ===
            `tracker.${fault === "drop_artifacts" ? "preserve_artifacts" : "authorized_successor"}`,
        ),
      ).toMatchObject({ ok: false });
    },
  );

  test.each(["duplicate_retry", "global_ownership", "global_children"] as const)(
    "rejects host %s regression",
    async (fault) => {
      const report = await runConformance(hostConformance(async () => fakeHostFixture(fault)));
      const scenario =
        fault === "duplicate_retry"
          ? "ambiguous_launch"
          : fault === "global_ownership"
            ? "pr_ownership"
            : "subagents";
      expect(report.results.find((result) => result.name === `host.${scenario}`)).toMatchObject({
        ok: false,
      });
    },
  );

  test("rejects a tracker that advertises conditional writes", async () => {
    const report = await runConformance(
      trackerConformance(async () => {
        const fixture = fakeTrackerFixture();
        fixture.adapter.describe = async () => ({ conditional_update: true, transition: true });
        return fixture;
      }),
    );
    expect(report.results.find((result) => result.name === "tracker.read_only")).toMatchObject({
      ok: false,
    });
  });

  test("rejects a tracker that acknowledges ambiguous writes", async () => {
    const report = await runConformance(
      trackerConformance(async () => {
        const fixture = fakeTrackerFixture();
        const apply = fixture.adapter.apply.bind(fixture.adapter);
        fixture.adapter.apply = async (request) => {
          try {
            await apply(request);
          } catch {}
        };
        return fixture;
      }),
    );
    expect(
      report.results.find((result) => result.name === "tracker.ambiguous_apply"),
    ).toMatchObject({ ok: false });
  });

  test.each(["message", "interrupt", "focus", "subagents", "pr_ownership"] as const)(
    "rejects false host %s capability",
    async (capability) => {
      const report = await runConformance(
        hostConformance(async () => {
          const fixture = fakeHostFixture();
          switch (capability) {
            case "message":
              fixture.adapter.message = async () => {};
              break;
            case "interrupt":
              fixture.adapter.interrupt = async () => {};
              break;
            case "focus":
              fixture.adapter.focus = async () => {};
              break;
            case "subagents":
              fixture.adapter.subagents = async () => [];
              break;
            case "pr_ownership":
              fixture.adapter.owns_pull_request = async () => true;
              break;
          }
          return fixture;
        }),
      );
      expect(report.results.find((result) => result.name === `host.${capability}`)).toMatchObject({
        ok: false,
      });
    },
  );

  test("rejects an acknowledged host launch that cannot be located", async () => {
    const report = await runConformance(
      hostConformance(async () => {
        const fixture = fakeHostFixture();
        fixture.adapter.locate = async () => null;
        return fixture;
      }),
    );
    expect(report.results.find((result) => result.name === "host.launch_and_locate")).toMatchObject(
      { ok: false },
    );
  });
});

test("host subagent conformance accepts children in separate worktrees", async () => {
  const report = await runConformance(
    hostConformance(async () => {
      const fixture = fakeHostFixture();
      const discover = fixture.adapter.subagents?.bind(fixture.adapter);
      if (!discover) throw new Error("Missing fake subagents");
      fixture.adapter.subagents = async (parent) =>
        (await discover(parent)).map((child) => ({
          ...child,
          workspace: { path: `/isolated/${child.id}` },
        }));
      const observe = fixture.observe;
      fixture.observe = async () => {
        const state = await observe();
        return {
          ...state,
          children: state.children.map((child) => ({
            ...child,
            session: { ...child.session, workspace: { path: `/isolated/${child.session.id}` } },
          })),
        };
      };
      return fixture;
    }),
  );
  expect(report.results.find((result) => result.name === "host.subagents")).toMatchObject({
    ok: true,
  });
});

test.each(["initial", "retry"])(
  "host conformance rejects an incorrect %s launch receipt",
  async (phase) => {
    const report = await runConformance(
      hostConformance(async () => {
        const fixture = fakeHostFixture();
        const launch = fixture.adapter.launch.bind(fixture.adapter);
        let calls = 0;
        fixture.adapter.launch = async (request) => {
          const receipt = await launch(request);
          calls += 1;
          if ((phase === "initial" && calls === 1) || (phase === "retry" && calls === 2))
            return {
              ...receipt,
              ticket: ticketRefSchema.parse("jira:test:TEST:ticket:OTHER-1"),
              workspace: { path: "/wrong-worktree" },
              state: "stopped",
            };
          return receipt;
        };
        return fixture;
      }),
    );
    expect(report.results.find((result) => result.name === "host.launch_and_locate")).toMatchObject(
      { ok: false },
    );
  },
);
