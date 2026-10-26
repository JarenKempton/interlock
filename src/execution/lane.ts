import { randomUUID } from "node:crypto";
import { laneRefSchema, ticketRefSchema } from "../domain/identifiers.ts";
import {
  createLane,
  type Lane,
  type LaneAction,
  type LaneCommand,
  type LaneRefusalCode,
  type LaneResult,
  nextLaneAction,
  transitionLane,
} from "../domain/lane.ts";
import type { LaneRef, Ticket, TicketRef } from "../domain/model.ts";
import type { TrackerRead } from "../domain/tracker.ts";
import type { StateStore } from "../persistence/state.ts";

export interface LaneTrackerPort {
  read(ticket: TicketRef): Promise<TrackerRead>;
  transition?(ticket: TicketRef, status: string): Promise<void>;
}

export interface LaneServiceOptions {
  store: Pick<StateStore, "saveLane" | "findLane" | "listLanes" | "laneForTicket">;
  tracker?: LaneTrackerPort;
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
  readonly #clock: { now(): Date };
  readonly #newId: () => LaneRef;

  constructor(options: LaneServiceOptions) {
    this.#store = options.store;
    this.#tracker = options.tracker;
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

export function laneTicketRef(value: string): TicketRef {
  return ticketRefSchema.parse(value);
}
