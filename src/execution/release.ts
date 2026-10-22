import { resolve } from "node:path";
import { GitWorkspaceAdapter } from "../adapters/workspaces/git.ts";
import { parseRef } from "../domain/reference.ts";
import { claimRef } from "../persistence/command-store.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import {
  claimCoordination,
  executionStatePath,
  executionTracker,
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
    const candidates = Object.keys(configuration.project.repositories)
      .map((name) => repositorySpec(configuration, name))
      .filter((repository) => resolve(repository.worktreeRoot, key ?? "") === run.workspace.path);
    const repository = candidates[0];
    if (candidates.length !== 1 || !repository)
      throw new Error("Recorded claim repository is missing or ambiguous");
    const jira = await executionTracker(
      configuration,
      parseRef(claim.ticket).workspace ?? "",
      services,
    );
    if (jira.owner !== claim.humanOwner)
      throw new Error("Only the recorded claim owner can release it");
    if (!claim.currentVersion)
      throw new Error("Claim has no verified lock version; inspect recovery evidence");
    const { claims, claimLock } = claimCoordination(repository, jira.tracker, services);
    await new GitWorkspaceAdapter(repository, services.execution?.git).preflight(
      (await jira.tracker.read(claim.ticket)).ticket,
    );
    const request = {
      claim: claim.ref,
      ticket: claim.ticket,
      claimedOwner: claim.humanOwner,
      originalSnapshot: claim.previousState,
      expectedVersion: claim.currentVersion,
      authorizedBy: jira.owner,
    };
    const before = await claimLock.read(claim.ticket);
    const released =
      before.record?.action === "release" &&
      before.record.claim === claim.ref &&
      before.record.run === run.ref &&
      before.record.owner === claim.humanOwner;
    if (!released && (claim.status !== "active" || before.version !== claim.currentVersion))
      throw new Error("Claim lock changed; release refused");
    store.recordStep(run.ref, "releasing", {
      claim: claim.ref,
      expectedVersion: claim.currentVersion,
    });
    try {
      if (!released) await claims.releaseClaim(request);
      await claims.verifyReleased(request);
      const verified = await claims.snapshotClaimState(claim.ticket);
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
