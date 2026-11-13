import { z } from "zod";
import { defineAction } from "../action.ts";
import { flag, optional, positional, text } from "../../cli/schema.ts";
import { executionConfigurationSchema } from "../../configuration/schema.ts";
import { type Claim, claimSchema, runSchema } from "../../domain/model.ts";
import { claimRef, runRef, withStore } from "../command-store.ts";
import { recoveryEvidenceRowSchema } from "../../persistence/schema/recovery-evidence.ts";
import { transactionStepRowSchema } from "../../persistence/schema/transaction-steps.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { laneActions } from "../lane/commands.ts";
import { executionStatePath, pickup, pickupResultSchema } from "./runtime.ts";
import { releaseClaim, releaseResultSchema } from "../claim/release.ts";
import { getExecutionConfiguration } from "../../configuration/store.ts";

const runExportSchema = z.strictObject({
  run: runSchema,
  claim: claimSchema.optional(),
  steps: z.array(
    transactionStepRowSchema
      .pick({ state: true, receipt_json: true, error_text: true, occurred_at: true })
      .strict(),
  ),
  recovery: z.array(
    recoveryEvidenceRowSchema
      .pick({ outcome: true, evidence_json: true, occurred_at: true })
      .strict(),
  ),
  configuration: executionConfigurationSchema.optional(),
});

export function runActions(services: RuntimeServices) {
  const run = positional(text("Recorded run reference.", "RUN"));
  const claim = positional(text("Recorded claim reference.", "CLAIM"));
  const state = optional(text("Local execution database path.", "PATH"));
  const local = (path?: string) => ({ ...services, statePath: executionStatePath(services, path) });
  return {
    pickup: defineAction({
      version: 2,
      description:
        "Claim a ticket, prepare its worktree, and return T3 launch arguments, or launch the lane with --launch.",
      input: {
        key: positional(text("Tracker ticket key.", "KEY")),
        config: optional(text("Shared interlock.toml path; defaults to the work repo's.", "PATH")),
        repo: optional(text("Work repo; defaults to the current directory.", "PATH")),
        branch: optional(text("Branch name; defaults to the branch user setting.", "NAME")),
        state,
        "t3-catalog": optional(
          text("Fresh T3 catalog for explicit selections; use - for stdin.", "PATH"),
        ),
        "dry-run": flag("Print the launch plan without mutations."),
        launch: flag("Launch the lane through the t3 CLI after claiming."),
      },
      result: pickupResultSchema,
      handler: (input) =>
        pickup(services, {
          key: input.key,
          config: input.config,
          repo: input.repo,
          branch: input.branch,
          state: input.state,
          t3Catalog: input["t3-catalog"],
          dryRun: input["dry-run"],
          launch: input.launch,
        }),
    }),
    runs: {
      list: defineAction({
        description: "List durable local runs.",
        version: 2,
        input: { state },
        result: z.array(runSchema),
        handler: (input) => withStore(local(input.state), (store) => store.listRuns()),
      }),
      show: defineAction({
        description: "Inspect a durable local run.",
        version: 2,
        input: { run, state },
        result: runSchema,
        handler: (input) => withStore(local(input.state), (store) => store.run(runRef(input.run))),
      }),
      export: defineAction({
        description: "Export a run, claim, steps, and recovery evidence.",
        input: { run, state },
        version: 3,
        result: runExportSchema,
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
              configuration: getExecutionConfiguration(store, ref),
            };
          }),
      }),
    },
    lane: laneActions(services),
    claim: {
      release: defineAction({
        description:
          "Restore the tracker and release the recorded owner's remote lock; preserve the workspace.",
        input: { claim, state },
        result: releaseResultSchema,
        handler: (input) => releaseClaim(services, input),
      }),
      show: defineAction({
        description: "Inspect a durable claim.",
        input: { claim, state },
        result: claimSchema,
        handler: (input) =>
          withStore(local(input.state), (store) => store.claim(claimRef(input.claim))),
      }),
    },
  };
}
