import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GitHubArtifactHost } from "../adapters/artifacts/github.ts";
import { BunGitCommandExecutor } from "../adapters/workspaces/git.ts";
import { defineAction } from "../cli/definition.ts";
import { choice, flag, optional, positional, text } from "../cli/schema.ts";
import { ticketRefSchema } from "../domain/identifiers.ts";
import { type LaneResult, laneActionSchema, laneResultSchema, laneSchema } from "../domain/lane.ts";
import { claimRef, laneRef, runRef } from "../persistence/command-store.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { LaneService } from "./lane.ts";
import { signedInLaneTracker } from "./lane-tracker.ts";
import { executionStatePath, withExecutionStore } from "./pickup-runtime.ts";
import { RecordedSubmissionAuthority } from "./submission.ts";

function exitCode(output: unknown): number {
  return typeof output === "object" && output !== null && "ok" in output && !output.ok ? 1 : 0;
}

const laneResult = laneResultSchema(laneSchema);

export function laneActions(services: RuntimeServices) {
  const lane = positional(text("Recorded lane reference.", "LANE"));
  const state = optional(text("Local execution database path.", "PATH"));
  const service = (store: Parameters<Parameters<typeof withExecutionStore>[2]>[0]) =>
    new LaneService({
      store,
      tracker: services.lane?.tracker ?? signedInLaneTracker(services),
      artifacts: services.lane?.artifacts ?? new GitHubArtifactHost(new BunGitCommandExecutor()),
      submissions:
        services.lane?.submissions ??
        new RecordedSubmissionAuthority(
          store,
          services.execution?.git ?? new BunGitCommandExecutor(),
        ),
      ...(services.execution?.clock ? { clock: services.execution.clock } : {}),
    });
  const withLane = <T>(
    path: string | undefined,
    operation: (laneService: LaneService) => Promise<T> | T,
  ) =>
    withExecutionStore(services, executionStatePath(services, path), async (store) =>
      operation(service(store)),
    );
  const apply = (
    id: string,
    path: string | undefined,
    command: Parameters<LaneService["apply"]>[1],
  ) => withLane(path, (laneService) => laneService.apply(laneRef(id), command));
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
    list: defineAction({
      description: "List durable local lanes.",
      input: { state },
      result: z.array(laneSchema),
      handler: (input) => withLane(input.state, (laneService) => laneService.list()),
    }),
    show: defineAction({
      description: "Inspect a durable local lane.",
      input: { lane, state },
      result: laneResult,
      handler: (input) =>
        withLane(input.state, (laneService) => laneService.get(laneRef(input.lane))),
      exitCode,
    }),
    next: defineAction({
      description: "Return exactly one next action for a lane.",
      input: { lane, state },
      result: laneResultSchema(laneActionSchema),
      handler: (input) =>
        withLane(input.state, (laneService) => laneService.next(laneRef(input.lane))),
      exitCode,
    }),
    claim: defineAction({
      description: "Claim a queued lane with its run and claim identity.",
      input: {
        lane,
        run: optional(text("Run reference.", "RUN")),
        claim: optional(text("Claim reference.", "CLAIM")),
        state,
      },
      result: laneResult,
      handler: (input) =>
        apply(input.lane, input.state, {
          type: "claim",
          run: runRef(input.run ?? `lane-${randomUUID()}`),
          claim: claimRef(input.claim ?? `lane-${randomUUID()}`),
        }),
      exitCode,
    }),
    start: defineAction({
      description: "Move a claimed lane to implementing.",
      input: { lane, state },
      result: laneResult,
      handler: (input) => apply(input.lane, input.state, { type: "start" }),
      exitCode,
    }),
    submit: defineAction({
      description:
        "Push the lane's recorded branch at a head commit and open or update its one pull request.",
      input: {
        lane,
        head: text("Head commit the evidence covers.", "HEAD"),
        gate: text("Evidence gate name.", "GATE"),
        "evidence-url": text("Evidence URL for the gate at the head commit.", "URL"),
        title: optional(text("Pull request title; the ticket key is prefixed.", "TITLE")),
        draft: flag("Open the pull request as a draft."),
        state,
      },
      result: laneResult,
      handler: (input) =>
        withLane(input.state, (laneService) =>
          laneService.submit(laneRef(input.lane), {
            head: input.head,
            evidence: [{ gate: input.gate, head: input.head, url: input["evidence-url"] }],
            ...(input.title ? { title: input.title } : {}),
            draft: input.draft === true,
          }),
        ),
      exitCode,
    }),
    review: defineAction({
      description: "Move a submitted lane to reviewing.",
      input: { lane, state },
      result: laneResult,
      handler: (input) => apply(input.lane, input.state, { type: "begin_review" }),
      exitCode,
    }),
    verdict: defineAction({
      description: "Record a review verdict bound to the submitted head commit.",
      input: {
        lane,
        head: text("Head commit reviewed.", "HEAD"),
        decision: choice("Review decision.", ["approved", "changes_requested"] as const),
        findings: optional(text("Finding for changes_requested.", "FINDING")),
        state,
      },
      result: laneResult,
      handler: (input) =>
        apply(input.lane, input.state, {
          type: "verdict",
          head: input.head,
          decision: input.decision,
          findings: input.findings ? [input.findings] : [],
        }),
      exitCode,
    }),
    merge: defineAction({
      description: "Mark an approved lane merged at the approved head commit.",
      input: {
        lane,
        head: text("Current head commit.", "HEAD"),
        state,
      },
      result: laneResult,
      handler: (input) => apply(input.lane, input.state, { type: "merge", head: input.head }),
      exitCode,
    }),
    complete: defineAction({
      description: "Complete a merged lane after tracker readback verifies the ticket is done.",
      input: { lane, state },
      result: laneResult,
      handler: (input) =>
        apply(input.lane, input.state, { type: "complete", trackerDoneVerified: false }),
      exitCode,
    }),
    attention: defineAction({
      description: "Route a lane to the user with a reason.",
      input: {
        lane,
        reason: text("Reason the lane needs the user.", "REASON"),
        state,
      },
      result: laneResult,
      handler: (input) =>
        apply(input.lane, input.state, { type: "attention", reason: input.reason }),
      exitCode,
    }),
    resume: defineAction({
      description: "Resume a lane from attention to its previous state.",
      input: { lane, state },
      result: laneResult,
      handler: (input) => apply(input.lane, input.state, { type: "resume" }),
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
        apply(input.lane, input.state, {
          type: "promote",
          ticket: ticketRefSchema.parse(input.ticket),
        }),
      exitCode,
    }),
  };
}

export type LaneActionResult = LaneResult<unknown>;
