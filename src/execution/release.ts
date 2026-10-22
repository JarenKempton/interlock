import { resolve } from "node:path";
import { z } from "zod";
import { GitWorkspaceAdapter } from "../adapters/workspaces/git.ts";
import { parseRef } from "../domain/reference.ts";
import { claimRef } from "../persistence/command-store.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import {
  executionStatePath,
  executionTracker,
  lockedTracker,
  repositorySpec,
  withExecutionStore,
} from "./pickup-runtime.ts";

export async function releaseClaim(
  services: RuntimeServices,
  input: { claim: string; state?: string | undefined },
) {
  return withExecutionStore(services, executionStatePath(services, input.state), async (store) => {
    const claim = store.claim(claimRef(input.claim));
    const run = store.run(claim.run);
    const configuration = store.getExecutionConfiguration(run.ref);
    if (!configuration) throw new Error("Release requires the recorded execution configuration");
    const key = parseRef(claim.ticket).nativeId;
    const intent = z
      .object({ receipt_json: z.string() })
      .parse(
        store
          .steps(run.ref)
          .find((step) => z.object({ state: z.literal("planning") }).safeParse(step).success),
      );
    const plan = z
      .object({ plan: z.object({ repository: z.string() }) })
      .parse(JSON.parse(intent.receipt_json)).plan;
    const repository = repositorySpec(configuration, plan.repository);
    if (resolve(repository.worktreeRoot, key ?? "") !== run.workspace.path)
      throw new Error("Recorded workspace does not match its selected repository");
    const jira = await executionTracker(
      configuration,
      parseRef(claim.ticket).workspace ?? "",
      services,
    );
    if (jira.owner !== claim.humanOwner)
      throw new Error("Only the recorded claim owner can release it");
    if (!claim.currentVersion)
      throw new Error("Claim has no verified lock version; inspect recovery evidence");
    const { tracker } = lockedTracker(repository, jira.tracker, services);
    await new GitWorkspaceAdapter(repository, services.execution?.git).preflightRepository();
    const request = {
      claim: claim.ref,
      ticket: claim.ticket,
      claimedOwner: claim.humanOwner,
      originalSnapshot: claim.previousState,
      expectedVersion: claim.currentVersion,
      authorizedBy: jira.owner,
    };
    const before = await tracker.snapshotClaimState(claim.ticket);
    const lock = z
      .object({
        lock: z.object({
          record: z
            .object({ action: z.string(), claim: z.string(), run: z.string(), owner: z.string() })
            .nullable(),
        }),
      })
      .parse(before.payload);
    const released =
      lock.lock.record?.action === "release" &&
      lock.lock.record.claim === claim.ref &&
      lock.lock.record.run === run.ref &&
      lock.lock.record.owner === claim.humanOwner;
    if (!released && (claim.status !== "active" || before.version !== claim.currentVersion))
      throw new Error("Claim lock changed; release refused");
    store.recordStep(run.ref, "releasing", {
      claim: claim.ref,
      expectedVersion: claim.currentVersion,
    });
    try {
      if (!released) await tracker.releaseClaim(request);
      await tracker.verifyReleased(request);
      const verified = await tracker.snapshotClaimState(claim.ticket);
      claim.status = "released";
      claim.currentVersion = verified.version;
      run.status = "released";
      run.updatedAt = (services.execution?.clock?.now() ?? new Date()).toISOString();
      const receipt = {
        ok: true,
        state: "released",
        run: run.ref,
        claim: claim.ref,
        ticket: claim.ticket,
        lockVersion: verified.version,
        mirror: "restored_verified",
      };
      store.commitRelease(run, claim, receipt);
      return receipt;
    } catch (error) {
      run.status = "recovery_required";
      store.saveRecoveryRequired(run, { claim: claim.ref }, error, {
        operation: "release",
        command: `interlock runs export ${run.ref}`,
        originalSnapshot: claim.previousState,
        owner: claim.humanOwner,
      });
      throw new Error(`Release requires recovery; interlock runs export ${run.ref}`, {
        cause: error,
      });
    }
  });
}
