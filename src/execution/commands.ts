import { defineAction } from "../cli/definition.ts";
import { flag, optional, positional, text } from "../cli/schema.ts";
import type { Claim } from "../domain/model.ts";
import { claimRef, runRef, withStore } from "../persistence/command-store.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { laneActions } from "./lane-commands.ts";
import { executionStatePath, pickup } from "./pickup-runtime.ts";
import { releaseClaim } from "./release.ts";

export function runActions(services: RuntimeServices) {
  const run = positional(text("Recorded run reference.", "RUN"));
  const claim = positional(text("Recorded claim reference.", "CLAIM"));
  const state = optional(text("Local execution database path.", "PATH"));
  const local = (path?: string) => ({ ...services, statePath: executionStatePath(services, path) });
  return {
    pickup: defineAction({
      description: "Claim a ticket, prepare its worktree, and return T3 launch arguments.",
      input: {
        key: positional(text("Jira ticket key.", "KEY")),
        config: optional(text("Shared interlock.toml path; defaults to the work repo's.", "PATH")),
        repo: optional(text("Work repo; defaults to the current directory.", "PATH")),
        branch: optional(text("Branch name; defaults to the branch user setting.", "NAME")),
        state,
        "t3-catalog": text("Fresh in-thread T3 catalog envelope; use - for stdin.", "PATH"),
        "dry-run": flag("Print the launch plan without mutations."),
      },
      handler: (input) =>
        pickup(services, {
          key: input.key,
          config: input.config,
          repo: input.repo,
          branch: input.branch,
          state: input.state,
          t3Catalog: input["t3-catalog"],
          dryRun: input["dry-run"],
        }),
    }),
    runs: {
      list: defineAction({
        description: "List durable local runs.",
        input: { state },
        handler: (input) => withStore(local(input.state), (store) => store.listRuns()),
      }),
      show: defineAction({
        description: "Inspect a durable local run.",
        input: { run, state },
        handler: (input) => withStore(local(input.state), (store) => store.run(runRef(input.run))),
      }),
      export: defineAction({
        description: "Export a run, claim, steps, and recovery evidence.",
        input: { run, state },
        handler: (input) =>
          withStore(local(input.state), (store) => {
            const ref = runRef(input.run);
            let claim: Claim | undefined;
            try {
              claim = store.claimForRun(ref);
            } catch {}
            return {
              run: store.run(ref),
              claim,
              steps: store.steps(ref),
              recovery: store.recoveryEvidence(ref),
              configuration: store.getExecutionConfiguration(ref),
            };
          }),
      }),
    },
    lane: laneActions(services),
    claim: {
      release: defineAction({
        description:
          "Restore Jira and release the recorded owner's remote lock; preserve the workspace.",
        input: { claim, state },
        handler: (input) => releaseClaim(services, input),
      }),
      show: defineAction({
        description: "Inspect a durable claim.",
        input: { claim, state },
        handler: (input) =>
          withStore(local(input.state), (store) => store.claim(claimRef(input.claim))),
      }),
    },
  };
}
