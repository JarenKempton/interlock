import { randomUUID } from "node:crypto";
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
import type { TrackerRead } from "../domain/tracker.ts";
import type { StateStore } from "../persistence/state.ts";

export interface LaneTrackerPort {
  read(ticket: TicketRef): Promise<TrackerRead>;
  transition?(ticket: TicketRef, status: string): Promise<void>;
  link_artifact?(ticket: TicketRef, url: string): Promise<void>;
}

export interface ArtifactWorkspace {
  path: string;
  branch: string;
}

export interface PullRequest {
  url: string;
  branch: string;
}

export interface ArtifactRequest {
  title: string;
  body: string;
  draft: boolean;
}

export interface ArtifactHost {
  push(workspace: ArtifactWorkspace, head: string): Promise<void>;
  pullRequests(workspace: ArtifactWorkspace, key?: string): Promise<PullRequest[]>;
  open(workspace: ArtifactWorkspace, request: ArtifactRequest): Promise<string>;
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
  readonly #clock: { now(): Date };
  readonly #newId: () => LaneRef;

  constructor(options: LaneServiceOptions) {
    this.#store = options.store;
    this.#tracker = options.tracker;
    this.#artifacts = options.artifacts;
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
    const key = lane.ticket ? parseRef(lane.ticket).nativeId : undefined;
    if (key && !workspace.branch.includes(key))
      return fail("gates_unmet", `Workspace branch ${workspace.branch} does not carry ${key}`);
    const found = await openPullRequests(artifacts, workspace, key);
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
    try {
      await artifacts.push(workspace, input.head);
    } catch {
      return fail("push_failed", `Push of ${workspace.branch} failed; lane remains implementing`);
    }
    const artifact = own[0]?.url ?? (await openPullRequest(artifacts, lane, workspace, key, input));
    if (!artifact)
      return fail(
        "ambiguous_write",
        "Pull request creation was not verified; resubmit to adopt or open it",
      );
    if (lane.ticket && this.#tracker?.link_artifact) {
      try {
        await this.#tracker.link_artifact(lane.ticket, artifact);
      } catch {
        return fail(
          "ambiguous_write",
          `Tracker link for ${artifact} was not verified; resubmit to retry`,
        );
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
      } catch {
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
  workspace: ArtifactWorkspace,
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
  workspace: ArtifactWorkspace,
  key: string | undefined,
  input: LaneSubmitInput,
): Promise<string | undefined> {
  const summary = input.title ?? lane.title ?? workspace.branch;
  const request = {
    title: key && !summary.includes(key) ? `${key}: ${summary}` : summary,
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
      return adopted.length === 1 ? adopted[0]?.url : undefined;
    } catch {
      return undefined;
    }
  }
}

export function laneTicketRef(value: string): TicketRef {
  return ticketRefSchema.parse(value);
}
