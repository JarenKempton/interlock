import { resolve } from "node:path";
import { z } from "zod";
import {
  JiraTrackerAdapter,
  PendingJiraWriteError,
  pendingJiraWriteSchema,
} from "../../adapters/trackers/jira/tracker.ts";
import { GitWorkspaceAdapter, gitWorkspaceFileSystem } from "../../adapters/git/workspace.ts";
import { lockExecution } from "../../persistence/execution-lock.ts";
import { CLAIM_RECORD_VERSION } from "../../domain/claim/lock.ts";
import { claimRefSchema, runRefSchema, ticketRefSchema } from "../../domain/refs/identifiers.ts";
import { parseRef } from "../../domain/refs/parse.ts";
import { claimRef } from "../command-store.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { journalJiraWrite, verifyJournaledJiraWrite } from "../tracker/write-journal.ts";
import {
  completionRecordMatches,
  releaseCompletedClaim,
} from "../../execution/claim/completion.ts";
import { trackerTicketIsDone } from "../../execution/lane/service.ts";
import {
  claimCoordination,
  executionStatePath,
  executionTarget,
  executionTracker,
  jiraRankField,
  withExecutionStore,
} from "../pickup/runtime.ts";
import { getExecutionConfiguration } from "../../configuration/store.ts";

export const releaseResultSchema = z.strictObject({
  ok: z.literal(true),
  state: z.literal("released"),
  run: runRefSchema,
  claim: claimRefSchema,
  ticket: ticketRefSchema,
  lockVersion: z.string(),
  mirror: z.enum(["restored_verified", "removed_verified"]),
});

export async function releaseClaim(
  services: RuntimeServices,
  input: { claim: string; state?: string | undefined },
) {
  return withExecutionStore(services, executionStatePath(services, input.state), async (store) => {
    const claim = store.claim(claimRef(input.claim));
    const key = parseRef(claim.ticket).nativeId;
    if (claim.recordVersion !== undefined && claim.recordVersion > CLAIM_RECORD_VERSION)
      throw new Error(
        `Claim ${claim.ref} on ${key} has record version ${claim.recordVersion}; upgrade Interlock to release it`,
      );
    if (
      !claim.claimHome ||
      !claim.claimHomeUrl ||
      !claim.lockRef ||
      claim.recordVersion !== CLAIM_RECORD_VERSION
    )
      throw new Error(
        `Claim ${claim.ref} on ${key} was made before claim homes; remove the interlock.claim property from ${key} and refs/interlock/claims/${key} from the claim remote to clear it`,
      );
    const home = { identity: claim.claimHome, url: claim.claimHomeUrl };
    const run = store.run(claim.run);
    const configuration = getExecutionConfiguration(store, run.ref);
    if (!configuration) throw new Error("Release requires the recorded execution configuration");
    const { repository, jiraSite, claimedStatus } = executionTarget(configuration);
    if (resolve(repository.worktreeRoot, key ?? "") !== run.workspace.path)
      throw new Error("Recorded workspace does not match its selected repository");
    const jira = await executionTracker(
      jiraSite,
      parseRef(claim.ticket).namespace ?? "",
      services,
      "release",
    );
    if (jira.owner !== claim.humanOwner)
      throw new Error("Only the recorded claim owner can release it");
    if (!claim.currentVersion)
      throw new Error("Claim has no verified lock version; inspect recovery evidence");
    const mirror = new JiraTrackerAdapter({
      ...jira.options,
      claimHome: home.identity,
      claimedStatus,
      journalWrite: (pending) => journalJiraWrite(store, run.ref, pending),
    });
    const { claims, claimLock } = claimCoordination(repository, mirror, services, home);
    if ((await claimLock.ref(claim.ticket)) !== claim.lockRef)
      throw new Error(`Claim lock ref ${claim.lockRef} is not supported by this Interlock`);
    await new GitWorkspaceAdapter(
      repository,
      services.execution?.git,
      gitWorkspaceFileSystem(lockExecution),
    ).preflightRepository();
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
    const fenced = Boolean(
      before.record?.claim.startsWith("interlock-claim:retirement-") &&
      completionRecordMatches(before.record, claim),
    );
    if (
      !released &&
      !fenced &&
      (claim.status !== "active" || before.version !== claim.currentVersion)
    )
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
      if (fenced) {
        const reader = new JiraTrackerAdapter({
          ...jira.options,
          rankField: await jiraRankField(jira.options.transport),
        });
        if (!trackerTicketIsDone((await reader.read(claim.ticket)).ticket))
          throw new Error("Retirement claim release requires verified Done");
        store.recordStep(run.ref, "completion_done_verified", { ticket: claim.ticket });
        await releaseCompletedClaim({
          lock: claimLock,
          claim,
          run,
          removeMirror: () =>
            mirror.removeMirror({
              claim: claim.ref,
              run: run.ref,
              ticket: claim.ticket,
              owner: claim.humanOwner,
            }),
          journal: (state, receipt) => store.recordStep(run.ref, state, receipt),
          releasePending: store
            .steps(run.ref)
            .some((step) => step.state === "completion_release_pending"),
        });
      } else {
        if (!released) await claims.releaseClaim(request);
        await claims.verifyReleased(request);
      }
      const verified = await claimLock.read(claim.ticket);
      claim.status = "released";
      claim.currentVersion = verified.version;
      run.status = "released";
      run.updatedAt = (services.execution?.clock?.now() ?? new Date()).toISOString();
      const receipt: z.infer<typeof releaseResultSchema> = {
        ok: true,
        state: "released",
        run: run.ref,
        claim: claim.ref,
        ticket: claim.ticket,
        lockVersion: verified.version,
        mirror: fenced ? "removed_verified" : "restored_verified",
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
