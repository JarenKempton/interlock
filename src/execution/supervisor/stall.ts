import type { HostSessionView } from "../../domain/host/capability.ts";
import type { ProgressMark } from "./ports.ts";

export type StallDecision =
  | { kind: "progressing"; mark: ProgressMark }
  | { kind: "waiting"; mark: ProgressMark }
  | { kind: "resume"; mark: ProgressMark }
  | { kind: "attention"; reason: "stalled" };

export const RESUME_MESSAGE =
  "Interlock supervisor: this lane has made no progress for a while. Continue the lane procedure from where you stopped. If you are blocked, run lane attention with the reason instead of waiting.";

export function progressFingerprint(view: HostSessionView): string {
  const last = view.messages.at(-1);
  return JSON.stringify([view.status, view.messages.length, last?.role, last?.text]);
}

export function stallDecision(
  previous: ProgressMark | undefined,
  view: HostSessionView,
  now: Date,
  policy: { stallAfterMs: number; maxResumes: number },
): StallDecision {
  const fingerprint = progressFingerprint(view);
  if (!previous || previous.fingerprint !== fingerprint)
    return {
      kind: "progressing",
      mark: { fingerprint, since: now.toISOString(), resumes: previous?.resumes ?? 0 },
    };
  if (now.getTime() - Date.parse(previous.since) < policy.stallAfterMs)
    return { kind: "waiting", mark: previous };
  if (previous.resumes >= policy.maxResumes) return { kind: "attention", reason: "stalled" };
  return {
    kind: "resume",
    mark: { fingerprint, since: now.toISOString(), resumes: previous.resumes + 1 },
  };
}
