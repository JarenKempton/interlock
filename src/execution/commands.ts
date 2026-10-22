import { defineAction } from "../cli/definition.ts";
import { positional, text } from "../cli/schema.ts";
import type { Claim } from "../domain/model.ts";
import { claimRef, runRef, withStore } from "../persistence/command-store.ts";
import type { RuntimeServices } from "../runtime-services.ts";

export function runActions(services: RuntimeServices) {
  const run = positional(text("Recorded run reference.", "RUN"));
  const claim = positional(text("Recorded claim reference.", "CLAIM"));
  return {
    runs: {
      list: defineAction({
        description: "List durable local runs.",
        input: {},
        handler: () => withStore(services, (store) => store.listRuns()),
      }),
      show: defineAction({
        description: "Inspect a durable local run.",
        input: { run },
        handler: (input) => withStore(services, (store) => store.run(runRef(input.run))),
      }),
      export: defineAction({
        description: "Export a run, claim, steps, and recovery evidence.",
        input: { run },
        handler: (input) =>
          withStore(services, (store) => {
            const ref = runRef(input.run);
            let claim: Claim | undefined;
            try {
              claim = store.claimForRun(ref);
            } catch {
              /* A run can exist before claiming. */
            }
            return {
              run: store.run(ref),
              claim,
              steps: store.steps(ref),
              recovery: store.recoveryEvidence(ref),
            };
          }),
      }),
    },
    claim: {
      show: defineAction({
        description: "Inspect a durable claim.",
        input: { claim },
        handler: (input) => withStore(services, (store) => store.claim(claimRef(input.claim))),
      }),
    },
  };
}
