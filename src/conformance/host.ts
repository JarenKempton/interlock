import type { LaunchRequest } from "../domain/contracts.ts";
import { HOST_CAPABILITIES, type Host, type HostSession } from "../domain/host.ts";
import { type ConformanceCase, requireBehavior, requireRejection } from "./runner.ts";

export interface HostFixture {
  adapter: Host;
  request: LaunchRequest;
  ownedPullRequest: string;
  unrelatedPullRequest: string;
  observe(): Promise<{
    sessions: readonly HostSession[];
    messages: readonly string[];
    focused: string | null;
    children: readonly { parentSessionId: string; session: HostSession }[];
  }>;
  loseLaunchReadback(): void | Promise<void>;
  restoreReadback(): void | Promise<void>;
}

export function hostConformance(create: () => Promise<HostFixture>): ConformanceCase[] {
  function scenario(name: string, run: (fixture: HostFixture) => Promise<void>) {
    return { name: `host.${name}`, run: async () => run(await create()) };
  }
  return [
    scenario("launch_and_locate", async ({ adapter, request, observe }) => {
      const capabilities = await adapter.describe();
      requireBehavior(
        Object.keys(capabilities).every((key) => HOST_CAPABILITIES.some((known) => known === key)),
        "Host advertised an unknown capability",
      );
      requireBehavior(
        (await adapter.locate(request.run)) === null,
        "Unlaunched run must locate as absent",
      );
      const launched = await adapter.launch(request);
      const located = await adapter.locate(request.run);
      requireBehavior(
        located?.id === launched.id &&
          located.run === request.run &&
          located.ticket === request.ticket.ref &&
          located.workspace.path === request.workspace.path &&
          located.workspace.branch === request.workspace.branch &&
          located.state === "running",
        "Launch could not be located with exact identity",
      );
      const repeated = await adapter.launch(request);
      requireBehavior(
        repeated.id === launched.id && (await observe()).sessions.length === 1,
        "Retry duplicated a host session",
      );
      await requireRejection(
        () =>
          adapter.launch({ ...request, workspace: { path: `${request.workspace.path}-other` } }),
        "claim_collision",
      );
    }),
    scenario(
      "ambiguous_launch",
      async ({ adapter, request, observe, loseLaunchReadback, restoreReadback }) => {
        await loseLaunchReadback();
        await requireRejection(() => adapter.launch(request), "ambiguous_tracker_result");
        const before = await observe();
        requireBehavior(
          before.sessions.length === 1,
          "Lost-response fixture did not commit a launch",
        );
        await restoreReadback();
        const retried = await adapter.launch(request);
        const located = await adapter.locate(request.run);
        requireBehavior(
          retried.id === before.sessions[0]?.id &&
            located?.id === retried.id &&
            located.run === request.run &&
            located.ticket === request.ticket.ref &&
            located.workspace.path === request.workspace.path &&
            (await observe()).sessions.length === 1,
          "Lost-response retry duplicated or lost the original session",
        );
      },
    ),
    ...HOST_CAPABILITIES.map((capability) =>
      scenario(capability, async (fixture) => {
        const { adapter, request, observe } = fixture;
        if (!(await adapter.describe())[capability]) return;
        const session = await adapter.launch(request);
        switch (capability) {
          case "message":
            requireBehavior(adapter.message, "Advertised message has no implementation");
            await adapter.message(session, "Conformance delivery probe");
            requireBehavior(
              (await observe()).messages.includes("Conformance delivery probe"),
              "Message was acknowledged without delivery",
            );
            break;
          case "interrupt":
            requireBehavior(adapter.interrupt, "Advertised interrupt has no implementation");
            await adapter.interrupt(session);
            requireBehavior(
              (await observe()).sessions.find((item) => item.id === session.id)?.state ===
                "stopped" && (await adapter.locate(request.run))?.state === "stopped",
              "Interrupt was not verified",
            );
            break;
          case "focus":
            requireBehavior(adapter.focus, "Advertised focus has no implementation");
            await adapter.focus(session);
            requireBehavior((await observe()).focused === session.id, "Focus was not verified");
            break;
          case "subagents": {
            requireBehavior(adapter.subagents, "Advertised subagents has no implementation");
            const other = await adapter.launch({
              ...request,
              run: "interlock-run:other",
              workspace: { path: `${request.workspace.path}-other` },
            });
            const children = await adapter.subagents(session);
            const others = await adapter.subagents(other);
            const observed = (await observe()).children
              .filter((child) => child.parentSessionId === session.id)
              .map((child) => child.session);
            requireBehavior(
              others.length > 0 &&
                others.every((child) => !children.some((item) => item.id === child.id)),
              "Subagent discovery crossed session ownership",
            );
            requireBehavior(
              observed.length > 0 &&
                children.length === observed.length &&
                observed.every((child) =>
                  children.some((item) => item.id === child.id && item.run === child.run),
                ),
              "Subagent discovery was not verified",
            );
            break;
          }
          case "pr_ownership": {
            requireBehavior(
              adapter.owns_pull_request,
              "Advertised PR ownership has no implementation",
            );
            requireBehavior(
              await adapter.owns_pull_request(session, fixture.ownedPullRequest),
              "Owned PR was not recognized",
            );
            requireBehavior(
              !(await adapter.owns_pull_request(session, fixture.unrelatedPullRequest)),
              "Unrelated PR was claimed",
            );
            const other = await adapter.launch({
              ...request,
              run: "interlock-run:other",
              workspace: { path: `${request.workspace.path}-other` },
            });
            requireBehavior(
              !(await adapter.owns_pull_request(other, fixture.ownedPullRequest)),
              "PR ownership leaked to an unrelated session",
            );
            break;
          }
        }
      }),
    ),
  ];
}
