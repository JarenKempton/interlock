import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { GitClaimLock, heldClaim } from "../../adapters/git/claim-lock.ts";
import { BunGitCommandExecutor, type GitCommandExecutor } from "../../adapters/git/workspace.ts";
import { normalizeClaimHome } from "../../domain/claim/home.ts";
import { ClaimLockUnavailableError } from "../../domain/claim/lock.ts";
import {
  AmbiguousTrackerResultError,
  ArtifactLinkConflictError,
  TrackerUnavailableError,
} from "../../domain/contracts.ts";
import { laneRefSchema, ticketRefSchema } from "../../domain/refs/identifiers.ts";
import {
  createLane,
  type Lane,
  type LaneAction,
  type LaneCommand,
  type LaneEvidence,
  type LaneRefusalCode,
  type LaneResult,
  nextLaneAction,
  isApprovedForHead,
  type MergeProof,
  mergeProofSchema,
  laneResultSchema,
  laneSchema,
  transitionLane,
  type Unblocked,
} from "../../domain/lane/lifecycle.ts";
import { type GateEvidence, trackerSource } from "../../domain/gate/evidence.ts";
import type { Claim, LaneRef, RunRef, Ticket, TicketRef } from "../../domain/model.ts";
import { completionRecordMatches, releaseCompletedClaim } from "../claim/completion.ts";
import { parseRef } from "../../domain/refs/parse.ts";
import { ticketKeyMatches } from "../../domain/submission/commit.ts";
import type { TrackerRead } from "../../domain/tracker/port.ts";
import type { StateStore } from "../../persistence/state.ts";
import { type AttachAuthority, AttachRefusal } from "../../app/lane/attachment.ts";
import { configuredPickable, unblockedBy } from "../pickup/eligibility.ts";

export interface LaneTrackerPort {
  read(ticket: TicketRef): Promise<TrackerRead>;
  transition?(ticket: TicketRef, status: string): Promise<void>;
  link_artifact?(ticket: TicketRef, url: string, title?: string): Promise<void>;
  available?(ticket: TicketRef): Promise<void>;
  removeMirror?(claim: Claim): Promise<void>;
}

export interface ArtifactWorkspace {
  path: string;
  branch: string;
}

export interface ArtifactTarget extends ArtifactWorkspace {
  repository: string;
  remote: string;
  head: string;
}

export interface PullRequest {
  url: string;
  branch: string;
  title?: string;
  state: "OPEN" | "CLOSED" | "MERGED";
}

export interface ArtifactRequest {
  title: string;
  body: string;
  draft: boolean;
}

export interface ArtifactHost {
  prepare(workspace: ArtifactWorkspace, head: string): Promise<ArtifactTarget>;
  push(target: ArtifactTarget): Promise<void>;
  pullRequests(target: ArtifactTarget, key?: string): Promise<PullRequest[]>;
  open(target: ArtifactTarget, request: ArtifactRequest): Promise<PullRequest>;
  merged?(url: string): Promise<MergeProof>;
}

export interface LaneSubmitInput {
  head: string;
  evidence: readonly LaneEvidence[];
  title?: string;
  draft?: boolean;
}

export interface LaneServiceOptions {
  store: Pick<
    StateStore,
    | "saveLane"
    | "findLane"
    | "listLanes"
    | "laneForTicket"
    | "run"
    | "listRuns"
    | "claim"
    | "claimForRun"
    | "steps"
    | "recordStep"
    | "commitLaneCompletion"
    | "saveRecoveryRequired"
    | "getExecutionConfiguration"
  >;
  tracker?: LaneTrackerPort;
  artifacts?: ArtifactHost;
  git?: GitCommandExecutor;
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
  readonly #git: GitCommandExecutor;
  readonly #attachments: AttachAuthority | undefined;
  readonly #clock: { now(): Date };
  readonly #newId: () => LaneRef;

  constructor(options: LaneServiceOptions) {
    this.#store = options.store;
    this.#tracker = options.tracker;
    this.#artifacts = options.artifacts;
    this.#git = options.git ?? new BunGitCommandExecutor();
    this.#attachments = options.attachments;
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#newId = options.newId ?? (() => laneRefSchema.parse(`interlock-lane:${randomUUID()}`));
  }

  create(input: { ticket?: string; title?: string; maxReviewRounds?: number }): LaneResult<Lane> {
    const ticket = input.ticket ? ticketRefSchema.parse(input.ticket) : undefined;
    if (ticket) {
      const existing = this.#store.laneForTicket(ticket);
      if (existing && existing.state !== "done")
        return fail("claim_collision", "Ticket already has an active lane");
    }
    const created = createLane(
      {
        id: this.#newId(),
        ...(ticket ? { ticket } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.maxReviewRounds !== undefined ? { maxReviewRounds: input.maxReviewRounds } : {}),
      },
      this.#clock.now().toISOString(),
    );
    if (created.refusal) return { ok: false, refusal: created.refusal };
    this.#store.saveLane(created.lane);
    return ok(created.lane);
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
    const queued = existing?.state === "queued" && !existing.run ? existing : undefined;
    if (existing && existing.state !== "done" && !queued) {
      if (existing.run === run.ref && existing.claim === claim.ref) return ok(existing);
      return fail("claim_collision", `Ticket already has lane ${existing.id} for another run`);
    }
    const now = this.#clock.now().toISOString();
    const created = queued
      ? { lane: queued }
      : createLane({ id: this.#newId(), ticket: ticket.data }, now);
    if (created.refusal) return { ok: false, refusal: created.refusal };
    let lane = created.lane;
    for (const command of [
      { type: "claim", run: run.ref, claim: claim.ref },
      { type: "start" },
    ] as const) {
      const transition = transitionLane(lane, command, now);
      if (transition.refusal) return { ok: false, refusal: transition.refusal };
      lane = transition.lane;
    }
    this.#store.saveLane(lane);
    return ok(lane);
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
    if (command.type === "claim" && lane.ticket) {
      const other = this.#store.laneForTicket(lane.ticket);
      if (other && other.id !== lane.id && other.state !== "done")
        return fail("claim_collision", "Ticket already has an active lane");
    }
    if (command.type === "promote") {
      const other = this.#store.laneForTicket(command.ticket);
      if (other && other.id !== lane.id && other.state !== "done")
        return fail("claim_collision", "Ticket already has an active lane");
    }
    const transition = transitionLane(lane, command, this.#clock.now().toISOString());
    if (!transition.refusal) this.#store.saveLane(transition.lane);
    return transition.refusal ? { ok: false, refusal: transition.refusal } : ok(transition.lane);
  }

  async submit(id: LaneRef, input: LaneSubmitInput): Promise<LaneResult<Lane>> {
    const lane = this.#store.findLane(id);
    if (!lane) return fail("lane_not_found", `Lane not found: ${id}`);
    const now = this.#clock.now().toISOString();
    const command = { type: "submit", head: input.head, evidence: input.evidence } as const;
    const pushOnly = input.evidence.length === 0;
    const gate = transitionLane(
      lane,
      {
        ...command,
        artifact: lane.artifact ?? "pending",
        ...(pushOnly ? { evidence: [{ gate: "push", head: input.head, url: "pending" }] } : {}),
      },
      now,
    );
    if (gate.refusal) return { ok: false, refusal: gate.refusal };
    const artifacts = this.#artifacts;
    if (!artifacts) return fail("unsupported_capability", "Submit requires an artifact host");
    const workspace = this.#workspace(lane);
    if (!workspace)
      return fail("workspace_unknown", "Lane has no recorded workspace branch to push");
    if (lane.ticket) {
      if (!this.#tracker?.link_artifact)
        return fail("tracker_unavailable", "Submit requires a tracker that links artifacts");
      try {
        await this.#tracker.available?.(lane.ticket);
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
    } catch {
      return fail("gates_unmet", "Submission head, branch, or remote cannot be verified");
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
    if (
      existing &&
      (existing.state !== "OPEN" || (key && !ticketKeyMatches(existing.title ?? "", key)))
    )
      return fail(
        "artifact_mismatch",
        "Existing PR must be open and its title must carry the ticket key",
      );
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
        const lock = new GitClaimLock({ repository: target.path, home, git: this.#git });
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
    } catch {
      return fail("push_failed", `Push of ${workspace.branch} failed; lane remains implementing`);
    }
    const pullRequest = existing ?? (await openPullRequest(artifacts, lane, target, key, input));
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
    if (lane.ticket && this.#tracker?.link_artifact) {
      try {
        await this.#tracker.link_artifact(lane.ticket, artifact, pullRequest.title);
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
    } catch {
      return fail("artifact_host_unavailable", `Could not verify ${lane.artifact}`);
    }
    if (!proof.merged) return fail("pull_request_unmerged", "Pull request is not merged");
    if (proof.branch !== workspace.branch || proof.url !== lane.artifact)
      return fail(
        "artifact_mismatch",
        "Merged pull request does not match the recorded branch and URL",
      );
    const gate = transitionLane(
      lane,
      { type: "complete", proof, trackerDoneVerified: true },
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
        lock: new GitClaimLock({
          repository: workspace.path,
          home: normalizeClaimHome(claim.claimHomeUrl),
          git: this.#git,
        }),
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
      const configuration = run ? this.#store.getExecutionConfiguration(run) : undefined;
      if (!configuration)
        return { state: "unknown", reason: "Run has no recorded pickup configuration" };
      if (!this.#tracker) return { state: "unknown", reason: "No tracker reads dependents" };
      const done = (await this.#tracker.read(ticket)).ticket;
      return {
        state: "known",
        tickets: await unblockedBy(this.#tracker, done, configuredPickable(configuration)),
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
        const canonical = async (path: string) =>
          realpath(path).catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
              return resolve(path);
            throw error;
          });
        if (
          (await canonical(this.#store.run(other.run).workspace.path)) ===
          (await canonical(run.workspace.path))
        )
          throw new Error(`Workspace is owned by lane ${other.id}`);
      }
    }
    if (!claim.claimHome || !claim.claimHomeUrl) throw new Error("Missing recorded claim home");
    const home = normalizeClaimHome(claim.claimHomeUrl);
    if (home.identity !== claim.claimHome) throw new Error("Recorded claim home identity changed");
    const state = await new GitClaimLock({
      repository: run.workspace.path,
      home,
      git: this.#git,
    }).read(run.ticket);
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
    if (!tracker.transition)
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
      await tracker.transition(ticket, "Done");
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
  } catch {
    return fail("artifact_host_unavailable", "Could not read pull requests in all states");
  }
}

async function openPullRequest(
  artifacts: ArtifactHost,
  lane: Lane,
  workspace: ArtifactTarget,
  key: string | undefined,
  input: LaneSubmitInput,
): Promise<PullRequest | undefined> {
  const summary = input.title ?? lane.title ?? workspace.branch;
  const request = {
    title: key && !ticketKeyMatches(summary, key) ? `${key}: ${summary}` : summary,
    body: [
      `Interlock lane ${lane.id}`,
      ...input.evidence.map((item) => `- ${item.gate} at ${item.head}: ${item.url}`),
    ].join("\n"),
    draft: input.draft === true,
  };
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
