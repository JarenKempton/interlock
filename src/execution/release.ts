import { resolve } from "node:path";
import { z } from "zod";
import {
  JiraTrackerAdapter,
  PendingJiraWriteError,
  pendingJiraWriteSchema,
} from "../adapters/trackers/jira.ts";
import { GitWorkspaceAdapter } from "../adapters/workspaces/git.ts";
import { parseRef } from "../domain/reference.ts";
import { claimRef } from "../persistence/command-store.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { journalJiraWrite, verifyJournaledJiraWrite } from "./jira-write-journal.ts";
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
      "release",
    );
    if (jira.owner !== claim.humanOwner)
      throw new Error("Only the recorded claim owner can release it");
    if (!claim.currentVersion)
      throw new Error("Claim has no verified lock version; inspect recovery evidence");
    const mirror = new JiraTrackerAdapter({
      ...jira.options,
      journalWrite: (pending) => journalJiraWrite(store, run.ref, pending),
    });
    const { claims, claimLock } = claimCoordination(repository, mirror, services);
    await new GitWorkspaceAdapter(repository, services.execution?.git).preflightRepository();
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
    const latest =
      run.status === "recovery_required" ? store.recoveryEvidence(run.ref).at(-1) : undefined;
    const pendingJiraWrite = latest
      ? z
          .object({ pendingJiraWrite: pendingJiraWriteSchema.optional() })
          .parse(JSON.parse(z.object({ evidence_json: z.string() }).parse(latest).evidence_json))
          .pendingJiraWrite
      : undefined;
    if (pendingJiraWrite && pendingJiraWrite.ticket !== claim.ticket)
      throw new Error("Pending Jira write ticket does not match the claim");
    const lastStep = z
      .object({ state: z.string(), receipt_json: z.string().nullable() })
      .parse(store.steps(run.ref).at(-1));
    if (
      lastStep.state === "releasing" &&
      !z
        .object({ journaledWrites: z.literal(true) })
        .safeParse(JSON.parse(lastStep.receipt_json ?? "null")).success
    )
      throw new Error("Unfinished legacy release requires recovery; inspect run evidence");
    store.recordStep(run.ref, "releasing", {
      claim: claim.ref,
      expectedVersion: claim.currentVersion,
      journaledWrites: true,
    });
    try {
      await verifyJournaledJiraWrite(store, run.ref, claim.ticket, mirror);
      if (pendingJiraWrite) await mirror.verifyPendingWrite(pendingJiraWrite);
      if (!released) await claims.releaseClaim(request);
      await claims.verifyReleased(request);
      const verified = await claimLock.read(claim.ticket);
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
        ...(error instanceof PendingJiraWriteError ? { pendingJiraWrite: error.pendingWrite } : {}),
      });
      throw new Error(`Release requires recovery; interlock runs export ${run.ref}`, {
        cause: error,
      });
    }
  });
}
