import { type ClaimHome, normalizeClaimHome } from "../../domain/claim/home.ts";
import {
  ClaimLockUnavailableError,
  heldClaim,
  type RecoverableClaimLock,
} from "../../domain/claim/lock.ts";
import {
  AmbiguousTrackerResultError,
  ArtifactLinkConflictError,
  TrackerUnavailableError,
} from "../../domain/contracts.ts";
import { laneRefSchema, ticketRefSchema } from "../../domain/refs/identifiers.ts";
import {
  createLane,
  isUnattached,
  type Lane,
  type LaneAction,
  type LaneCommand,
  type LaneEvidence,
  type LaneRefusalCode,
  type LaneResult,
  nextLaneAction,
  isApprovedForHead,
  pushRefusal,
  type MergeProof,
  mergeProofSchema,
  laneResultSchema,
  laneSchema,
  transitionLane,
  type Unblocked,
} from "../../domain/lane/lifecycle.ts";
import { type GateEvidence, trackerSource } from "../../domain/gate/evidence.ts";
import type { Claim, ClaimRef, LaneRef, Run, RunRef, TicketRef } from "../../domain/model.ts";
import type { Ticket } from "../../domain/tracker/ticket.ts";
import { completionRecordMatches, releaseCompletedClaim } from "../claim/completion.ts";
import { parseRef } from "../../domain/refs/parse.ts";
import { ticketKeyMatches } from "../../domain/submission/commit.ts";
import type { PickableStatuses, TrackerRead } from "../../domain/tracker/port.ts";
import type {
  ArtifactHost,
  ArtifactTarget,
  ArtifactWorkspace,
  PullRequest,
} from "../../domain/submission/artifact.ts";
import { unblockedBy } from "../pickup/eligibility.ts";
import { type AttachAuthority, AttachRefusal } from "./attachment.ts";

export interface LaneTrackerPort {
  read(ticket: TicketRef): Promise<TrackerRead>;
  complete?(ticket: TicketRef): Promise<void>;
  linkArtifact?(ticket: TicketRef, url: string, title?: string): Promise<void>;
  available?(ticket: TicketRef): Promise<void>;
  removeMirror?(claim: Claim): Promise<void>;
}

export interface LaneSubmitInput {
  head: string;
  evidence: readonly LaneEvidence[];
  title?: string;
  body?: string;
  draft?: boolean;
}

export interface LaneStore {
  saveLane(lane: Lane): void;
  findLane(id: LaneRef): Lane | undefined;
  listLanes(): Lane[];
  laneForTicket(ticket: string): Lane | undefined;
  run(ref: RunRef): Run;
  listRuns(): Run[];
  claim(ref: ClaimRef): Claim;
  claimForRun(run: RunRef): Claim;
  steps(run: RunRef): readonly { state: string; receipt_json: string | null }[];
  recordStep(run: RunRef, state: string, receipt?: unknown, error?: unknown): void;
  commitLaneCompletion(lane: Lane, receipt: unknown, lockVersion: string): void;
  grantReviewRound(lane: Lane, receipt: unknown): void;
  saveRecoveryRequired(run: Run, receipt: unknown, error: unknown, evidence: unknown): void;
}

export interface LaneServiceOptions {
  store: LaneStore;
  claimLock: (repository: string, home: ClaimHome) => RecoverableClaimLock;
  canonicalPath: (path: string) => Promise<string>;
  pickable: (run: RunRef) => PickableStatuses | undefined;
  baseMergesOnly: (
    path: string,
    approved: string,
    proof: MergeProof,
  ) => Promise<"yes" | "no" | "unverifiable">;
  tracker?: LaneTrackerPort;
  artifacts?: ArtifactHost;
  attachments?: AttachAuthority;
  clock?: { now(): Date };
  newId?: () => LaneRef;
}

function ok<T>(value: T): LaneResult<T> {
  return { ok: true, value };
}

function fail<T>(code: LaneRefusalCode, message: string): LaneResult<T> {
  return { ok: false, refusal: { code, message } };
}

export function trackerTicketIsDone(ticket: Ticket): boolean {
  const status = ticket.status.trim().toLowerCase();
  return (
    ticket.state === "closed" || status === "done" || status === "closed" || status === "resolved"
  );
}

export class LaneService {
  readonly #store: LaneServiceOptions["store"];
  readonly #tracker: LaneTrackerPort | undefined;
  readonly #artifacts: ArtifactHost | undefined;
  readonly #claimLock: LaneServiceOptions["claimLock"];
  readonly #canonicalPath: LaneServiceOptions["canonicalPath"];
  readonly #pickable: LaneServiceOptions["pickable"];
  readonly #baseMergesOnly: LaneServiceOptions["baseMergesOnly"];
  readonly #attachments: AttachAuthority | undefined;
  readonly #clock: { now(): Date };
  readonly #newId: () => LaneRef;

  constructor(options: LaneServiceOptions) {
    this.#store = options.store;
    this.#tracker = options.tracker;
    this.#artifacts = options.artifacts;
    this.#claimLock = options.claimLock;
    this.#canonicalPath = options.canonicalPath;
    this.#pickable = options.pickable;
    this.#baseMergesOnly = options.baseMergesOnly;
    this.#attachments = options.attachments;
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#newId =
      options.newId ?? (() => laneRefSchema.parse(`interlock-lane:${crypto.randomUUID()}`));
  }

  async attach(input: { ticket: string; worktree: string }): Promise<LaneResult<Lane>> {
    const ticket = ticketRefSchema.safeParse(input.ticket);
    if (!ticket.success) return fail("gates_unmet", "Attach requires a tracker ticket reference");
    const runs = this.#store
      .listRuns()
      .filter((run) => run.ticket === ticket.data && run.status === "claimed");
    const run = runs[0];
    if (!run) return fail("gates_unmet", "Ticket has no claimed run; run pickup first");
    if (runs.length > 1)
      return fail("claim_collision", "Ticket has more than one claimed run; release the extras");
    let claim: ReturnType<LaneServiceOptions["store"]["claimForRun"]>;
    try {
      claim = this.#store.claimForRun(run.ref);
    } catch {
      return fail("claim_collision", "Claimed run has no recorded claim");
    }
    if (claim.status !== "active" || claim.ticket !== ticket.data || claim.run !== run.ref)
      return fail("claim_collision", "Run's claim is not the active claim for this ticket");
    if (!this.#attachments)
      return fail("unsupported_capability", "Attach requires worktree and claim verification");
    try {
      await this.#attachments.verify(run, claim, input.worktree);
    } catch (error) {
      if (error instanceof AttachRefusal) return fail(error.code, error.message);
      return fail("workspace_unknown", errorMessage(error, "Worktree could not be verified"));
    }
    const existing = this.#store.laneForTicket(ticket.data);
    const unattached = existing && isUnattached(existing) ? existing : undefined;
    if (existing && existing.state !== "done" && !unattached) {
      if (existing.run === run.ref && existing.claim === claim.ref) return ok(existing);
      return fail("claim_collision", `Ticket already has lane ${existing.id} for another run`);
    }
    const now = this.#clock.now().toISOString();
    const transition = transitionLane(
      unattached ?? createLane({ id: this.#newId(), ticket: ticket.data }, now),
      { type: "attach", run: run.ref, claim: claim.ref },
      now,
    );
    if (transition.refusal) return { ok: false, refusal: transition.refusal };
    this.#store.saveLane(transition.lane);
    return ok(transition.lane);
  }

  get(id: LaneRef): LaneResult<Lane> {
    const lane = this.#store.findLane(id);
    return lane ? ok(lane) : fail("lane_not_found", `Lane not found: ${id}`);
  }

  list(): Lane[] {
    return this.#store.listLanes();
  }

  next(id: LaneRef): LaneResult<LaneAction> {
    const lane = this.#store.findLane(id);
    return lane ? ok(nextLaneAction(lane)) : fail("lane_not_found", `Lane not found: ${id}`);
  }

  async apply(id: LaneRef, command: LaneCommand): Promise<LaneResult<Lane>> {
    const lane = this.#store.findLane(id);
    if (!lane) return fail("lane_not_found", `Lane not found: ${id}`);
    if (command.type === "complete") return this.#complete(lane);
    const transition = transitionLane(lane, command, this.#clock.now().toISOString());
    if (!transition.refusal) this.#store.saveLane(transition.lane);
    return transition.refusal ? { ok: false, refusal: transition.refusal } : ok(transition.lane);
  }

  grantRound(id: LaneRef): LaneResult<Lane> {
    const lane = this.#store.findLane(id);
    if (!lane) return fail("lane_not_found", `Lane not found: ${id}`);
    if (!lane.run) return fail("invalid_transition", "Cannot grant a round before lane attach");
    const transition = transitionLane(
      lane,
      { type: "grant_round" },
      this.#clock.now().toISOString(),
    );
    if (transition.refusal) return { ok: false, refusal: transition.refusal };
    this.#store.grantReviewRound(transition.lane, {
      lane: lane.id,
      reviewRound: lane.reviewRound,
      maxReviewRounds: transition.lane.maxReviewRounds,
      state: transition.lane.state,
    });
    return ok(transition.lane);
  }

  async submit(id: LaneRef, input: LaneSubmitInput): Promise<LaneResult<Lane>> {
    const lane = this.#store.findLane(id);
    if (!lane) return fail("lane_not_found", `Lane not found: ${id}`);
    const now = this.#clock.now().toISOString();
    const command = { type: "submit", head: input.head, evidence: input.evidence } as const;
    const pushOnly = input.evidence.length === 0;
    const refusal = pushOnly
      ? pushRefusal(lane, input.head)
      : transitionLane(lane, { ...command, artifact: lane.artifact ?? "pending" }, now).refusal;
    if (refusal) return { ok: false, refusal };
    const artifacts = this.#artifacts;
    if (!artifacts) return fail("unsupported_capability", "Submit requires an artifact host");
    const workspace = this.#workspace(lane);
    if (!workspace)
      return fail("workspace_unknown", "Lane has no recorded workspace branch to push");
    let summary = input.title;
    if (lane.ticket) {
      if (!this.#tracker?.linkArtifact)
        return fail("tracker_unavailable", "Submit requires a tracker that links artifacts");
      try {
        await this.#tracker.available?.(lane.ticket);
        summary ??= (await this.#tracker.read(lane.ticket)).ticket.title;
      } catch (error) {
        return fail("tracker_unavailable", errorMessage(error, "Tracker is unavailable"));
      }
    }
    const key = lane.ticket ? parseRef(lane.ticket).nativeId : undefined;
    if (key && !ticketKeyMatches(workspace.branch, key))
      return fail("gates_unmet", `Workspace branch ${workspace.branch} does not carry ${key}`);
    let target: ArtifactTarget;
    try {
      target = await artifacts.prepare(workspace, input.head);
    } catch (error) {
      return fail(
        "gates_unmet",
        `Submission head, branch, or remote cannot be verified: ${errorMessage(error, "unknown")}`,
      );
    }
    const found = await findPullRequests(artifacts, target, key);
    if (!found.ok) return found;
    const others = found.value.filter((item) => item.branch !== workspace.branch);
    const own = found.value.filter((item) => item.branch === workspace.branch);
    if (others.length > 0 || own.length > 1)
      return fail(
        "duplicate_artifact",
        `Pull request candidates are not unique to this lane: ${[...others, ...own].map((item) => item.url).join(", ")}`,
      );
    if (lane.artifact && own[0]?.url !== lane.artifact)
      return fail(
        "duplicate_artifact",
        `Lane pull request ${lane.artifact} is not open on ${workspace.branch}; refusing a second pull request`,
      );
    const existing = own[0];
    if (existing && existing.state !== "OPEN")
      return fail("artifact_mismatch", `Existing PR ${existing.url} is ${existing.state}`);
    if (!lane.run || !lane.claim)
      return fail("unsupported_capability", "Submit requires recorded run/claim identity");
    try {
      const run = this.#store.run(lane.run);
      if (
        run.workspace.path !== target.path ||
        run.workspace.branch !== target.branch ||
        run.status !== "claimed"
      )
        return fail("claim_collision", "Submission does not match the claimed run workspace");
      if (lane.ticket) {
        const claim = this.#store.claim(lane.claim);
        if (
          run.ticket !== lane.ticket ||
          claim.ticket !== lane.ticket ||
          claim.run !== run.ref ||
          claim.status !== "active" ||
          !claim.claimHomeUrl ||
          !claim.claimHome
        )
          return fail("claim_collision", "Submission requires the recorded active ticket claim");
        const home = normalizeClaimHome(claim.claimHomeUrl);
        if (home.identity !== claim.claimHome)
          return fail("claim_collision", "Recorded claim home identity does not match");
        const lock = this.#claimLock(target.path, home);
        const held = heldClaim(await lock.read(lane.ticket));
        if (
          !held ||
          held.claim !== lane.claim ||
          held.run !== lane.run ||
          held.owner !== claim.humanOwner
        )
          return fail("claim_collision", "Remote claim is not held by this submission owner");
      }
    } catch {
      return fail("claim_collision", "Submission ownership could not be verified");
    }
    try {
      await artifacts.push(target);
    } catch (error) {
      return fail(
        "push_failed",
        `Push of ${workspace.branch} failed; lane remains ${lane.state}: ${errorMessage(error, "unknown")}`,
      );
    }
    const request = {
      title: pullRequestTitle(key, summary ?? workspace.branch),
      body: pullRequestBody(lane, input),
      draft: input.draft === true,
    };
    let pullRequest: PullRequest | undefined;
    if (existing) {
      try {
        pullRequest = await artifacts.update(target, existing.url, {
          title: request.title,
          ...(input.body === undefined ? {} : { body: request.body }),
        });
      } catch (error) {
        return fail(
          "artifact_host_unavailable",
          `Pushed, but ${existing.url} was not updated; resubmit to retry: ${errorMessage(error, "unknown")}`,
        );
      }
    } else pullRequest = await openPullRequest(artifacts, target, request);
    if (!pullRequest)
      return fail(
        "ambiguous_write",
        "Pull request creation was not verified; resubmit to adopt or open it",
      );
    if (
      pullRequest.branch !== target.branch ||
      pullRequest.state !== "OPEN" ||
      (key && !ticketKeyMatches(pullRequest.title ?? "", key))
    )
      return fail("artifact_mismatch", "Created PR identity could not be verified");
    const artifact = pullRequest.url;
    this.#store.saveLane({ ...lane, artifact, updatedAt: now });
    if (lane.ticket && this.#tracker?.linkArtifact) {
      try {
        await this.#tracker.linkArtifact(lane.ticket, artifact, pullRequest.title);
      } catch (error) {
        return linkRefusal(error, artifact);
      }
    }
    if (pushOnly) return ok({ ...lane, artifact, updatedAt: now });
    const transition = transitionLane(lane, { ...command, artifact }, now);
    if (transition.refusal) return { ok: false, refusal: transition.refusal };
    this.#store.saveLane(transition.lane);
    return ok(transition.lane);
  }

  #workspace(lane: Lane): ArtifactWorkspace | undefined {
    if (!lane.run) return undefined;
    try {
      const { path, branch } = this.#store.run(lane.run).workspace;
      return path && branch ? { path, branch } : undefined;
    } catch {
      return undefined;
    }
  }

  resolve(input: { lane?: string | undefined; ticket?: string | undefined }): LaneResult<Lane> {
    if (Boolean(input.lane) === Boolean(input.ticket))
      return fail("gates_unmet", "Provide exactly one lane reference or --ticket KEY");
    if (input.lane) return this.get(laneRefSchema.parse(input.lane));
    const matches = this.#store
      .listLanes()
      .filter(
        (lane) =>
          lane.ticket &&
          (lane.ticket === input.ticket || parseRef(lane.ticket).nativeId === input.ticket),
      );
    if (matches.length > 1)
      return fail("claim_collision", "Ticket resolves to multiple lanes; use its lane reference");
    const lane = matches[0];
    return lane
      ? this.get(lane.id)
      : fail("lane_not_found", `Lane not found for ticket: ${input.ticket}`);
  }

  async complete(input: { lane?: string; ticket?: string }): Promise<LaneResult<Lane>> {
    const resolved = this.resolve(input);
    return resolved.ok ? this.#complete(resolved.value) : resolved;
  }

  async #complete(lane: Lane): Promise<LaneResult<Lane>> {
    const steps = lane.run ? this.#store.steps(lane.run) : [];
    if (lane.state === "done") {
      const receipt = steps.findLast(
        (step) =>
          step.state === "lane_completed" &&
          step.receipt_json &&
          JSON.parse(step.receipt_json).value?.id === lane.id,
      );
      if (!receipt?.receipt_json) return ok(lane);
      const result = laneResultSchema(laneSchema).parse(JSON.parse(receipt.receipt_json));
      return result.ok
        ? {
            ok: true,
            value: result.value,
            ...(result.unblocked ? { unblocked: result.unblocked } : {}),
            ...(result.receipts ? { receipts: result.receipts } : {}),
          }
        : result;
    }
    if (lane.state !== "approved" && lane.state !== "merged")
      return fail("invalid_transition", `Cannot complete a lane in ${lane.state}`);
    if (!lane.head || !isApprovedForHead(lane, lane.head))
      return fail("stale_evidence", "Completion requires approval of the recorded head");
    const artifacts = this.#artifacts;
    if (!artifacts?.merged)
      return fail("unsupported_capability", "Completion requires merge readback");
    const workspace = this.#workspace(lane);
    if (!workspace) return fail("workspace_unknown", "Lane has no recorded workspace branch");
    if (!lane.artifact) {
      try {
        const target = await artifacts.prepare(workspace, lane.head);
        const candidates = (await artifacts.pullRequests(target)).filter(
          (item) => item.branch === workspace.branch && item.state === "MERGED",
        );
        const candidate = candidates[0];
        if (candidates.length !== 1 || !candidate)
          return fail(
            "artifact_required",
            "Expected exactly one merged pull request on the recorded branch",
          );
        lane = { ...lane, artifact: candidate.url };
      } catch {
        return fail(
          "artifact_host_unavailable",
          "Could not adopt the lane pull request by head branch",
        );
      }
    }
    if (!lane.artifact || !lane.run || !lane.claim)
      return fail("workspace_unknown", "Completion requires a recorded run and pull request");
    let proof: MergeProof;
    try {
      proof = mergeProofSchema.parse(await artifacts.merged(lane.artifact));
    } catch (error) {
      return fail(
        "artifact_host_unavailable",
        `Could not verify ${lane.artifact}: ${errorMessage(error, "unknown")}`,
      );
    }
    if (!proof.merged) return fail("pull_request_unmerged", "Pull request is not merged");
    if (proof.branch !== workspace.branch || proof.url !== lane.artifact)
      return fail(
        "artifact_mismatch",
        "Merged pull request does not match the recorded branch and URL",
      );
    const history =
      lane.head !== undefined && proof.head !== lane.head
        ? await this.#baseMergesOnly(workspace.path, lane.head, proof)
        : "no";
    if (history === "unverifiable")
      return fail(
        "artifact_host_unavailable",
        `Could not read the history between the approved head and ${proof.head}; retry completion (needs git 2.38 or later)`,
      );
    const baseMergesOnly = history === "yes";
    const gate = transitionLane(
      lane,
      {
        type: "complete",
        proof,
        trackerDoneVerified: true,
        ...(baseMergesOnly ? { baseMergesOnly } : {}),
      },
      this.#clock.now().toISOString(),
    );
    if (gate.refusal) return { ok: false, refusal: gate.refusal };
    const intent = { lane: lane.id, run: lane.run, claim: lane.claim, ticket: lane.ticket, proof };
    const saved = steps.findLast(
      (step) =>
        step.state === "lane_completion_pending" &&
        step.receipt_json &&
        JSON.parse(step.receipt_json).lane === lane.id,
    );
    if (
      saved?.receipt_json &&
      JSON.stringify(JSON.parse(saved.receipt_json)) !== JSON.stringify(intent)
    )
      return fail(
        "recovery_required",
        "Completion identity or merge proof changed; reconcile the journal",
      );
    try {
      await this.#verifyCompletionOwner(lane);
    } catch (error) {
      if (error instanceof ClaimLockUnavailableError) return claimLockUnreadable(error);
      this.#completionRecovery(lane, error);
      return fail("claim_collision", errorMessage(error, "Lane ownership is not verified"));
    }
    this.#store.saveLane(lane);
    if (!saved) this.#store.recordStep(lane.run, "lane_completion_pending", intent);
    const done = await this.#verifyDone(lane);
    if (!done.ok) return done;
    this.#store.recordStep(lane.run, "completion_done_verified", { ticket: lane.ticket });
    const unblocked = lane.ticket ? await this.#unblocked(lane.ticket, lane.run) : undefined;
    const observedAt = () => this.#clock.now().toISOString();
    const receipts: GateEvidence[] = [
      {
        gate: "merge",
        fact: "pull_request_merged",
        source: { system: "github", ref: proof.url },
        observed: { value: proof.commit ?? proof.head },
        observedAt: observedAt(),
      },
      ...(lane.ticket
        ? [
            {
              gate: "tracker_done",
              fact: "ticket_done",
              source: trackerSource(lane.ticket),
              observed: { value: done.value },
              observedAt: observedAt(),
            },
          ]
        : []),
    ];
    try {
      const claim = this.#store.claim(lane.claim);
      const tracker = this.#tracker;
      const run = lane.run;
      if (!tracker?.removeMirror || !claim.claimHomeUrl)
        throw new Error("Completion requires mirror removal and the recorded claim home");
      const removeMirror = tracker.removeMirror.bind(tracker);
      const lockVersion = await releaseCompletedClaim({
        lock: this.#claimLock(workspace.path, normalizeClaimHome(claim.claimHomeUrl)),
        claim,
        run: this.#store.run(lane.run),
        removeMirror: () => removeMirror(claim),
        journal: (state, receipt) => this.#store.recordStep(run, state, receipt),
        releasePending: steps.some((step) => step.state === "completion_release_pending"),
      });
      const result: LaneResult<Lane> = {
        ok: true,
        value: gate.lane,
        ...(unblocked ? { unblocked } : {}),
        receipts: [
          ...receipts,
          {
            gate: "mirror_removed",
            fact: "claim_mirror_removed",
            source: trackerSource(claim.ticket),
            observed: { value: "removed_verified" },
            observedAt: observedAt(),
          },
          {
            gate: "claim_released",
            fact: "claim_lock_released",
            source: { system: "git", ref: claim.lockRef ?? claim.claimHomeUrl },
            observed: { value: lockVersion },
            observedAt: observedAt(),
          },
        ],
      };
      this.#store.commitLaneCompletion(gate.lane, result, lockVersion);
      return result;
    } catch (error) {
      this.#completionRecovery(lane, error);
      return fail("recovery_required", errorMessage(error, "Completion release requires recovery"));
    }
  }

  async #unblocked(ticket: TicketRef, run: RunRef | undefined): Promise<Unblocked> {
    try {
      const pickable = run ? this.#pickable(run) : undefined;
      if (!pickable)
        return { state: "unknown", reason: "Run has no recorded pickup configuration" };
      if (!this.#tracker) return { state: "unknown", reason: "No tracker reads dependents" };
      const done = (await this.#tracker.read(ticket)).ticket;
      return {
        state: "known",
        tickets: await unblockedBy(this.#tracker, done, pickable),
      };
    } catch (error) {
      return { state: "unknown", reason: errorMessage(error, "Tracker read failed") };
    }
  }

  async #verifyCompletionOwner(lane: Lane): Promise<void> {
    const current = this.#store.findLane(lane.id);
    if (
      current?.state !== lane.state ||
      current.run !== lane.run ||
      current.claim !== lane.claim ||
      current.head !== lane.head ||
      current.ticket !== lane.ticket ||
      (current.artifact && current.artifact !== lane.artifact) ||
      JSON.stringify(current.verdict) !== JSON.stringify(lane.verdict)
    )
      throw new Error("Lane changed during completion");
    if (!lane.run || !lane.claim) throw new Error("Lane has no recorded run and claim");
    const run = this.#store.run(lane.run);
    const claim = this.#store.claim(lane.claim);
    const steps = this.#store.steps(run.ref);
    const recovering =
      run.status === "recovery_required" &&
      steps.some((step) => step.state === "lane_completion_pending");
    if (
      (run.status !== "claimed" && !recovering) ||
      claim.status !== "active" ||
      claim.run !== run.ref ||
      claim.ticket !== run.ticket ||
      (lane.ticket && lane.ticket !== run.ticket)
    )
      throw new Error("Lane, run and active claim identities do not match");
    for (const other of this.#store.listLanes()) {
      if (other.id === lane.id) continue;
      if (other.run === lane.run || other.claim === lane.claim)
        throw new Error(`Run or claim is shared with lane ${other.id}`);
      if (other.run && other.state !== "done") {
        if (
          (await this.#canonicalPath(this.#store.run(other.run).workspace.path)) ===
          (await this.#canonicalPath(run.workspace.path))
        )
          throw new Error(`Workspace is owned by lane ${other.id}`);
      }
    }
    if (!claim.claimHome || !claim.claimHomeUrl) throw new Error("Missing recorded claim home");
    const home = normalizeClaimHome(claim.claimHomeUrl);
    if (home.identity !== claim.claimHome) throw new Error("Recorded claim home identity changed");
    const state = await this.#claimLock(run.workspace.path, home).read(run.ticket);
    if (
      !completionRecordMatches(state.record, claim) ||
      (state.record?.action === "release" &&
        !steps.some((step) => step.state === "completion_release_pending"))
    )
      throw new Error("Remote claim no longer authorizes completion");
  }

  #completionRecovery(lane: Lane, error: unknown): void {
    if (!lane.run) return;
    const run = this.#store.run(lane.run);
    run.status = "recovery_required";
    this.#store.saveRecoveryRequired(run, { lane: lane.id }, error, {
      operation: "completion",
      claim: lane.claim,
    });
  }

  async #verifyDone(lane: Lane): Promise<LaneResult<string>> {
    if (!lane.ticket) return ok("not_applicable");
    const tracker = this.#tracker;
    if (!tracker)
      return fail("unsupported_capability", "Completing a ticket lane requires a tracker readback");
    const ticket = lane.ticket;
    const read = async (): Promise<LaneResult<string | false>> => {
      try {
        const readback = (await tracker.read(ticket)).ticket;
        if (readback.ref !== ticket)
          return fail("tracker_not_done", "Tracker returned another ticket");
        return ok(trackerTicketIsDone(readback) && readback.status);
      } catch (error) {
        if (error instanceof TrackerUnavailableError)
          return fail("tracker_unavailable", error.message);
        return fail("tracker_not_done", "Tracker readback failed; lane remains incomplete");
      }
    };
    const before = await read();
    if (!before.ok) return before;
    if (before.value) return ok(before.value);
    if (!tracker.complete)
      return fail("unsupported_capability", "Tracker cannot mark the ticket done");
    try {
      await this.#verifyCompletionOwner(lane);
    } catch (error) {
      if (error instanceof ClaimLockUnavailableError) return claimLockUnreadable(error);
      this.#completionRecovery(lane, error);
      return fail("claim_collision", errorMessage(error, "Remote claim changed"));
    }
    let failure: unknown;
    try {
      if (lane.run) this.#store.recordStep(lane.run, "completion_done_pending", { ticket });
      await tracker.complete(ticket);
    } catch (error) {
      failure = error ?? new Error("Tracker done transition failed");
    }
    const after = await read();
    if (after.ok && after.value) return ok(after.value);
    if (failure instanceof AmbiguousTrackerResultError || (failure && !after.ok))
      return fail(
        "ambiguous_write",
        "Tracker done transition was not verified; lane remains incomplete",
      );
    if (failure)
      return fail(
        "tracker_write_failed",
        errorMessage(failure, "Tracker done transition failed; lane remains incomplete"),
      );
    if (!after.ok)
      return fail(
        "tracker_not_done",
        "Tracker readback after done transition failed; lane remains incomplete",
      );
    return fail("tracker_not_done", "Tracker readback has not verified the ticket is done");
  }
}

async function findPullRequests(
  artifacts: ArtifactHost,
  workspace: ArtifactTarget,
  key: string | undefined,
): Promise<LaneResult<PullRequest[]>> {
  try {
    return ok(await artifacts.pullRequests(workspace, key));
  } catch (error) {
    return fail(
      "artifact_host_unavailable",
      `Could not read pull requests in all states: ${errorMessage(error, "unknown")}`,
    );
  }
}

function pullRequestTitle(key: string | undefined, summary: string): string {
  return key && !ticketKeyMatches(summary, key) ? `${key}: ${summary}` : summary;
}

function pullRequestBody(lane: Lane, input: LaneSubmitInput): string {
  return [
    ...(input.body?.trim() ? [input.body.trim(), "", "---"] : []),
    `Interlock lane ${lane.id}`,
    ...input.evidence.map((item) => `- ${item.gate} at ${item.head}: ${item.url}`),
  ].join("\n");
}

async function openPullRequest(
  artifacts: ArtifactHost,
  workspace: ArtifactTarget,
  request: { title: string; body: string; draft: boolean },
): Promise<PullRequest | undefined> {
  try {
    return await artifacts.open(workspace, request);
  } catch {
    try {
      const adopted = (await artifacts.pullRequests(workspace)).filter(
        (item) => item.branch === workspace.branch,
      );
      return adopted.length === 1 ? adopted[0] : undefined;
    } catch {
      return undefined;
    }
  }
}

function claimLockUnreadable<T>(error: ClaimLockUnavailableError): LaneResult<T> {
  return fail(
    "tracker_unavailable",
    `Claim lock is unreadable; retry completion: ${error.message}`,
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function linkRefusal<T>(error: unknown, artifact: string): LaneResult<T> {
  if (error instanceof TrackerUnavailableError) return fail("tracker_unavailable", error.message);
  if (error instanceof ArtifactLinkConflictError) return fail("artifact_mismatch", error.message);
  if (error instanceof AmbiguousTrackerResultError)
    return fail(
      "ambiguous_write",
      `Tracker link for ${artifact} was not verified; resubmit to retry`,
    );
  return fail("tracker_write_failed", errorMessage(error, `Tracker link for ${artifact} failed`));
}

export function laneTicketRef(value: string): TicketRef {
  return ticketRefSchema.parse(value);
}
