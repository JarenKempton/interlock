import { randomUUID } from "node:crypto";
import {
  AmbiguousTrackerResultError,
  ArtifactLinkConflictError,
  TrackerUnavailableError,
} from "../domain/contracts.ts";
import { laneRefSchema, ticketRefSchema } from "../domain/identifiers.ts";
import {
  createLane,
  type Lane,
  type LaneAction,
  type LaneCommand,
  type LaneEvidence,
  type LaneRefusalCode,
  type LaneResult,
  nextLaneAction,
  transitionLane,
} from "../domain/lane.ts";
import type { LaneRef, Ticket, TicketRef } from "../domain/model.ts";
import { parseRef } from "../domain/reference.ts";
import {
  type SubmissionAuthority,
  SubmissionRefusal,
  ticketKeyMatches,
} from "../domain/submission.ts";
import type { TrackerRead } from "../domain/tracker.ts";
import type { StateStore } from "../persistence/state.ts";

export interface LaneTrackerPort {
  read(ticket: TicketRef): Promise<TrackerRead>;
  transition?(ticket: TicketRef, status: string): Promise<void>;
  link_artifact?(ticket: TicketRef, url: string, title?: string): Promise<void>;
  available?(ticket: TicketRef): Promise<void>;
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
}

export interface LaneSubmitInput {
  head: string;
  evidence: readonly LaneEvidence[];
  title?: string;
  draft?: boolean;
}

export interface LaneServiceOptions {
  store: Pick<StateStore, "saveLane" | "findLane" | "listLanes" | "laneForTicket" | "run">;
  tracker?: LaneTrackerPort;
  artifacts?: ArtifactHost;
  submissions?: SubmissionAuthority;
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
  readonly #submissions: SubmissionAuthority | undefined;
  readonly #clock: { now(): Date };
  readonly #newId: () => LaneRef;

  constructor(options: LaneServiceOptions) {
    this.#store = options.store;
    this.#tracker = options.tracker;
    this.#artifacts = options.artifacts;
    this.#submissions = options.submissions;
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
    this.#store.saveLane(transition.lane);
    return transition.refusal ? { ok: false, refusal: transition.refusal } : ok(transition.lane);
  }

  async submit(id: LaneRef, input: LaneSubmitInput): Promise<LaneResult<Lane>> {
    const lane = this.#store.findLane(id);
    if (!lane) return fail("lane_not_found", `Lane not found: ${id}`);
    const now = this.#clock.now().toISOString();
    const command = { type: "submit", head: input.head, evidence: input.evidence } as const;
    const gate = transitionLane(lane, { ...command, artifact: lane.artifact ?? "pending" }, now);
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
    const found = await openPullRequests(artifacts, target, key);
    if (!found.ok) return found;
    const others = found.value.filter((item) => item.branch !== workspace.branch);
    const own = found.value.filter((item) => item.branch === workspace.branch);
    if (others.length > 0 || own.length > 1)
      return fail(
        "duplicate_artifact",
        `Ticket already has an open pull request: ${[...others, ...own].map((item) => item.url).join(", ")}`,
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
    if (!this.#submissions || !lane.run || !lane.claim)
      return fail(
        "unsupported_capability",
        "Submit requires shared submission authority and recorded run/claim identity",
      );
    let mayCreate: boolean;
    try {
      ({ mayCreate } = await this.#submissions.reserve(
        {
          lane: lane.id,
          run: lane.run,
          claim: lane.claim,
          ...(lane.ticket ? { ticket: lane.ticket } : {}),
          repository: target.repository,
          branch: target.branch,
        },
        target.path,
      ));
    } catch (error) {
      if (error instanceof SubmissionRefusal) return fail(error.code, error.message);
      return fail("recovery_required", "Submission authority could not be verified");
    }
    if (!existing && !mayCreate)
      return fail(
        "recovery_required",
        "PR creation was already reserved; reconcile its outcome instead of issuing another create",
      );
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

  async #complete(lane: Lane): Promise<LaneResult<Lane>> {
    if (lane.state !== "merged") {
      const transition = transitionLane(
        lane,
        { type: "complete", trackerDoneVerified: false },
        this.#clock.now().toISOString(),
      );
      return {
        ok: false,
        refusal: transition.refusal ?? {
          code: "invalid_transition",
          message: "Lane is not merged",
        },
      };
    }
    let verified = false;
    if (!lane.ticket) {
      verified = true;
    } else {
      if (!this.#tracker)
        return fail(
          "unsupported_capability",
          "Completing a ticket lane requires a tracker readback",
        );
      let readback: TrackerRead;
      try {
        readback = await this.#tracker.read(lane.ticket);
      } catch (error) {
        if (error instanceof TrackerUnavailableError)
          return fail("tracker_unavailable", error.message);
        return fail("tracker_not_done", "Tracker readback failed; lane remains merged");
      }
      if (trackerTicketIsDone(readback.ticket)) {
        verified = true;
      } else {
        if (!this.#tracker.transition)
          return fail("unsupported_capability", "Tracker cannot mark the ticket done");
        try {
          await this.#tracker.transition(lane.ticket, "Done");
        } catch {
          return fail("ambiguous_write", "Tracker done transition failed; lane remains merged");
        }
        try {
          readback = await this.#tracker.read(lane.ticket);
        } catch {
          return fail(
            "tracker_not_done",
            "Tracker readback after done transition failed; lane remains merged",
          );
        }
        if (!trackerTicketIsDone(readback.ticket))
          return fail("tracker_not_done", "Tracker readback has not verified the ticket is done");
        verified = true;
      }
    }
    const transition = transitionLane(
      lane,
      { type: "complete", trackerDoneVerified: verified },
      this.#clock.now().toISOString(),
    );
    this.#store.saveLane(transition.lane);
    return transition.refusal ? { ok: false, refusal: transition.refusal } : ok(transition.lane);
  }
}

async function openPullRequests(
  artifacts: ArtifactHost,
  workspace: ArtifactTarget,
  key: string | undefined,
): Promise<LaneResult<PullRequest[]>> {
  try {
    return ok(await artifacts.pullRequests(workspace, key));
  } catch {
    return fail("artifact_host_unavailable", "Could not read open pull requests");
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
