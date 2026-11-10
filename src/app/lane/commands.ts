import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { GitHubArtifactHost } from "../../adapters/github/artifact.ts";
import { BunGitCommandExecutor } from "../../adapters/git/workspace.ts";
import { defineAction } from "../action.ts";
import { choice, flag, optional, positional, text } from "../../cli/schema.ts";
import { ticketRefSchema } from "../../domain/refs/identifiers.ts";
import { parseRef } from "../../domain/refs/parse.ts";
import {
  type LaneResult,
  laneActionSchema,
  laneResultSchema,
  laneSchema,
} from "../../domain/lane/lifecycle.ts";
import { claimRef, laneRef, runRef } from "../command-store.ts";
import type { StateStore } from "../../persistence/state.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { RecordedAttachAuthority } from "./attachment.ts";
import { LaneService } from "../../execution/lane/service.ts";
import { signedInLaneTracker } from "../tracker/signed-in.ts";
import { executionStatePath, withExecutionStore } from "../pickup/runtime.ts";
import { gitLaneService } from "./service.ts";

function exitCode(output: unknown): number {
  return typeof output === "object" && output !== null && "ok" in output && !output.ok ? 1 : 0;
}

const laneResult = laneResultSchema(laneSchema);

export function laneService(services: RuntimeServices, store: StateStore): LaneService {
  return gitLaneService({
    store,
    tracker: services.lane?.tracker ?? signedInLaneTracker(services, store),
    artifacts: services.lane?.artifacts ?? new GitHubArtifactHost(new BunGitCommandExecutor()),
    git: services.execution?.git ?? new BunGitCommandExecutor(),
    attachments:
      services.lane?.attachments ??
      new RecordedAttachAuthority(services.execution?.git ?? new BunGitCommandExecutor()),
    ...(services.execution?.clock ? { clock: services.execution.clock } : {}),
  });
}

export function laneActions(services: RuntimeServices) {
  const lane = positional(text("Recorded lane reference.", "LANE"));
  const ticket = optional(text("Ticket key or tracker reference.", "TICKET"));
  const selector = { lane: optional(lane), ticket };
  const state = optional(text("Local execution database path.", "PATH"));
  const withLane = <T>(
    path: string | undefined,
    operation: (laneService: LaneService) => Promise<T> | T,
  ) => {
    const statePath = executionStatePath(services, path);
    return withExecutionStore(services, statePath, async (store) =>
      operation(laneService({ ...services, statePath }, store)),
    );
  };
  const selected = <T>(
    input: { lane?: string | undefined; ticket?: string | undefined; state?: string | undefined },
    operation: (
      laneService: LaneService,
      id: Parameters<LaneService["get"]>[0],
    ) => Promise<LaneResult<T>> | LaneResult<T>,
  ) =>
    withLane(input.state, (laneService) => {
      const result = laneService.resolve({
        ...input,
        ...(input.lane ? { lane: String(laneRef(input.lane)) } : {}),
      });
      return result.ok ? operation(laneService, result.value.id) : result;
    });
  const apply = (
    input: { lane?: string | undefined; ticket?: string | undefined; state?: string | undefined },
    command: Parameters<LaneService["apply"]>[1],
  ) => selected(input, (laneService, id) => laneService.apply(id, command));
  return {
    create: defineAction({
      description: "Create a queued lane for a ticket or a one-off local task.",
      input: {
        ticket: optional(text("Tracker ticket reference.", "TICKET")),
        title: optional(text("One-off task title.", "TITLE")),
        "max-review-rounds": optional(text("Maximum review rounds before attention.", "ROUNDS")),
        state,
      },
      result: laneResult,
      handler: (input) =>
        withLane(input.state, (laneService) =>
          laneService.create({
            ...(input.ticket ? { ticket: input.ticket } : {}),
            ...(input.title ? { title: input.title } : {}),
            ...(input["max-review-rounds"]
              ? { maxReviewRounds: Number(input["max-review-rounds"]) }
              : {}),
          }),
        ),
      exitCode,
    }),
    attach: defineAction({
      description:
        "Verify the claimed run's worktree, branch and remote claim, then bind the ticket's lane to it before work starts.",
      input: {
        ticket: text("Tracker ticket reference from the launch message.", "TICKET"),
        worktree: optional(text("Worktree to verify; defaults to the current directory.", "PATH")),
        state,
      },
      result: laneResult,
      handler: (input) =>
        withLane(input.state, (laneService) =>
          laneService.attach({
            ticket: input.ticket,
            worktree: resolve(services.configuration?.cwd ?? process.cwd(), input.worktree ?? "."),
          }),
        ),
      exitCode,
    }),
    list: defineAction({
      description: "List durable local lanes.",
      input: { state, ticket },
      result: z.array(laneSchema),
      handler: (input) =>
        withLane(input.state, (laneService) =>
          laneService
            .list()
            .filter(
              (lane) =>
                !input.ticket ||
                lane.ticket === input.ticket ||
                (lane.ticket && parseRef(lane.ticket).nativeId === input.ticket),
            ),
        ),
    }),
    show: defineAction({
      description: "Inspect a durable local lane.",
      input: { ...selector, state },
      result: laneResult,
      handler: (input) => selected(input, (laneService, id) => laneService.get(id)),
      exitCode,
    }),
    next: defineAction({
      description: "Return exactly one next action for a lane.",
      input: { ...selector, state },
      result: laneResultSchema(laneActionSchema),
      handler: (input) => selected(input, (laneService, id) => laneService.next(id)),
      exitCode,
    }),
    claim: defineAction({
      description: "Claim a queued lane with its run and claim identity.",
      input: {
        ...selector,
        run: optional(text("Run reference.", "RUN")),
        claim: optional(text("Claim reference.", "CLAIM")),
        state,
      },
      result: laneResult,
      handler: (input) =>
        apply(input, {
          type: "claim",
          run: runRef(input.run ?? `lane-${randomUUID()}`),
          claim: claimRef(input.claim ?? `lane-${randomUUID()}`),
        }),
      exitCode,
    }),
    start: defineAction({
      description: "Move a claimed lane to implementing.",
      input: { ...selector, state },
      result: laneResult,
      handler: (input) => apply(input, { type: "start" }),
      exitCode,
    }),
    submit: defineAction({
      description:
        "Push the lane's recorded branch at a head commit and open or update its one pull request.",
      input: {
        ...selector,
        head: text("Head commit the evidence covers.", "HEAD"),
        gate: optional(text("Evidence gate name; omit with --evidence-url to push first.", "GATE")),
        "evidence-url": optional(
          text("Evidence URL for the gate at the pushed head commit.", "URL"),
        ),
        title: optional(text("Pull request title; the ticket key is prefixed.", "TITLE")),
        draft: flag("Open the pull request as a draft."),
        state,
      },
      result: laneResult,
      validate(input) {
        if ((input.gate === undefined) !== (input["evidence-url"] === undefined))
          throw new Error("Pass --gate and --evidence-url together, or neither to push first");
      },
      handler: (input) =>
        selected(input, (laneService, id) =>
          laneService.submit(id, {
            head: input.head,
            evidence:
              input.gate && input["evidence-url"]
                ? [{ gate: input.gate, head: input.head, url: input["evidence-url"] }]
                : [],
            ...(input.title ? { title: input.title } : {}),
            draft: input.draft === true,
          }),
        ),
      exitCode,
    }),
    review: defineAction({
      description: "Move a submitted lane to reviewing.",
      input: { ...selector, state },
      result: laneResult,
      handler: (input) => apply(input, { type: "begin_review" }),
      exitCode,
    }),
    verdict: defineAction({
      description: "Record a review verdict bound to the submitted head commit.",
      input: {
        ...selector,
        head: text("Head commit reviewed.", "HEAD"),
        decision: choice("Review decision.", ["approved", "changes_requested"] as const),
        findings: optional(text("Finding for changes_requested.", "FINDING")),
        state,
      },
      result: laneResult,
      handler: (input) =>
        apply(input, {
          type: "verdict",
          head: input.head,
          decision: input.decision,
          findings: input.findings ? [input.findings] : [],
        }),
      exitCode,
    }),
    complete: defineAction({
      description:
        "Verify a merged pull request at the approved head, finish the ticket and report unblocked tickets without removing its workspace.",
      input: {
        lane: optional(lane),
        ticket: optional(text("Ticket key or tracker reference.", "TICKET")),
        state,
      },
      result: laneResult,
      handler: (input) =>
        withLane(input.state, (laneService) =>
          laneService.complete({
            ...(input.lane ? { lane: String(laneRef(input.lane)) } : {}),
            ...(input.ticket ? { ticket: input.ticket } : {}),
          }),
        ),
      exitCode,
    }),
    attention: defineAction({
      description: "Route a lane to the user with a reason.",
      input: {
        ...selector,
        reason: text("Reason the lane needs the user.", "REASON"),
        state,
      },
      result: laneResult,
      handler: (input) => apply(input, { type: "attention", reason: input.reason }),
      exitCode,
    }),
    resume: defineAction({
      description: "Resume a lane from attention to its previous state.",
      input: { ...selector, state },
      result: laneResult,
      handler: (input) => apply(input, { type: "resume" }),
      exitCode,
    }),
    promote: defineAction({
      description: "Promote a one-off lane to a tracker ticket.",
      input: {
        lane,
        ticket: text("Tracker ticket reference.", "TICKET"),
        state,
      },
      result: laneResult,
      handler: (input) =>
        apply(
          { lane: input.lane, state: input.state },
          {
            type: "promote",
            ticket: ticketRefSchema.parse(input.ticket),
          },
        ),
      exitCode,
    }),
  };
}

export type LaneActionResult = LaneResult<unknown>;
