import type { Ticket, TicketKind } from "../domain/model.ts";

const ROLE_TEMPLATES: Record<TicketKind, string> = {
  task: "Implement only the selected task and verify its acceptance criteria. Report the implementation artifact and verification evidence.",
  research:
    "Investigate only the selected research question using primary sources. Report a linked findings artifact and evidence.",
  prototype:
    "Build only the selected prototype to answer its decision question. Report the artifact and verdict.",
  decision:
    "Gather the human's decision for the selected ticket. Do not answer on the human's behalf.",
};
/** Extract conventional Markdown, Jira plain headings, or VERIFY sections without discarding the original description. */
export function acceptanceCriteria(description: string): string | undefined {
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    /^(?:#{1,6}\s*|h[1-6]\.\s*)?(?:\*\*)?(?:acceptance criteria|acceptance|ac|verify)(?:\*\*)?\s*(?:\([^\n]*\))?\s*:?\s*$/i.test(
      line.trim(),
    ),
  );
  if (start < 0) return undefined;
  const level = (line: string) => {
    const markdown = /^(#{1,6})\s+/.exec(line.trim());
    const jira = /^h([1-6])\.\s+/.exec(line.trim());
    return markdown?.[1]?.length ?? (jira ? Number(jira[1]) : undefined);
  };
  const sectionLevel = level(lines[start] ?? "");
  let fence: string | undefined;
  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return false;
    }
    if (fence) return false;
    const nextLevel = level(line);
    if (nextLevel !== undefined) return sectionLevel === undefined || nextLevel <= sectionLevel;
    return /^[A-Z][A-Z /_-]{2,}:?\s*$/.test(line);
  });
  return (
    lines
      .slice(start + 1, end < 0 ? undefined : end)
      .join("\n")
      .trim() || undefined
  );
}
export interface ReviewerTarget {
  instanceId: string;
  model: string;
  options: Record<string, string | boolean>;
}
export interface LaneProcedure {
  command: readonly string[];
  state?: string;
  reviewers: Record<string, ReviewerTarget>;
}
export interface LaunchPromptOptions {
  roleTemplate?: string;
  runtimeContract?: string;
  tracker?: string;
  lane?: LaneProcedure;
}

function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function laneProcedure(ticket: Ticket, lane: LaneProcedure): string {
  const run = (...args: string[]) =>
    `\`${[...lane.command, ...args, ...(lane.state ? ["--state", lane.state] : [])].map(shellWord).join(" ")}\``;
  const lenses = Object.entries(lane.reviewers);
  const review = lenses.length
    ? [
        `5. Run ${run("lane", "review", "LANE", "--json")}. Then start one fresh delegate_task per review lens, in parallel, with role review and the exact target below. Brief each with the lens, the PR URL and the head SHA; each returns approved or changes_requested with findings.`,
        ...lenses.map(
          ([lens, target]) =>
            `   - ${lens}: target ${JSON.stringify({ providerInstanceId: target.instanceId, model: target.model, options: target.options })}`,
        ),
        `6. Record one verdict for that head: ${run("lane", "verdict", "LANE", "--head", "SHA", "--decision", "approved")} only when every lens approved; otherwise --decision changes_requested --findings with every finding joined. On changes_requested, fix, commit and repeat from step 3 with the new head; the lane routes to attention at its review round limit.`,
      ]
    : [
        `5. No review lenses are planned. Run ${run("lane", "review", "LANE", "--json")}, then ${run("lane", "attention", "LANE", "--reason", "review_required")}, and wait; a person reviews, runs ${run("lane", "resume", "LANE")} and records the verdict with ${run("lane", "verdict", "LANE", "--head", "SHA", "--decision", "approved")}.`,
        "6. On changes_requested, fix, commit and repeat from step 3 with the new head; once the verdict for the head is approved, continue with step 7.",
      ];
  return [
    "Lane procedure:",
    `1. Before any work, run ${run("lane", "attach", "--ticket", ticket.ref, "--json")} from this worktree. If it refuses, report the refusal and stop. Its value.id is LANE below.`,
    "2. Implement and commit on this branch only. Do not push, open, edit or merge pull requests, and do not use GitHub write tools or credentials; Interlock pushes and opens the pull request.",
    `3. When your checks pass at HEAD, run ${run("lane", "submit", "LANE", "--head", "SHA", "--gate", "GATE", "--evidence-url", "URL", "--json")} with the full HEAD SHA, the check you ran, and a link to its result for that SHA. It pushes the branch and opens or updates this lane's one pull request.`,
    "4. Call link_pull_request with the returned value.artifact URL, then watch_pull_request on it. Link and watch no other pull request.",
    ...review,
    `7. Merge is not yours. When the watched pull request merges at the approved head, run ${run("lane", "merge", "LANE", "--head", "SHA")} and then ${run("lane", "complete", "LANE", "--json")}, which verifies the merge, moves the ticket to Done and removes this worktree and branch. Then unwatch the pull request.`,
    "Interlock refusals are final for that step: report them instead of working around them.",
  ].join("\n");
}
export function buildLaunchPrompt(ticket: Ticket, options: LaunchPromptOptions = {}): string {
  const criteria = ticket.acceptanceCriteria ?? acceptanceCriteria(ticket.description ?? "");
  return [
    ...(options.runtimeContract ? [`Read the runtime contract:\n${options.runtimeContract}`] : []),
    ...(options.tracker ? [`Tracker:\n${options.tracker}`] : []),
    ...(ticket.map ? [`Map:\n${ticket.map}`] : []),
    `Ticket:\n${ticket.ref}${ticket.title ? ` — ${ticket.title}` : ""}`,
    `Role:\n${ticket.kind}`,
    `Role guidance:\n${options.roleTemplate ?? ROLE_TEMPLATES[ticket.kind]}`,
    `Description:\n${ticket.description ?? "Not supplied by tracker."}`,
    `Acceptance criteria:\n${criteria ?? "Not supplied by tracker; verify with the ticket owner before completion."}`,
    "Required output:\n- Report the work performed and link any resulting artifacts.\n- Report acceptance evidence, unverified criteria, and remaining blockers.",
    ...(options.lane ? [laneProcedure(ticket, options.lane)] : []),
    `Authorization and completion:\n${options.lane ? "Apart from the Interlock lane commands above, this" : "This"} prompt does not grant authority to mutate tracker state, close tickets, or update maps. Follow the project/workflow instructions and explicit authorization for those actions. Passing acceptance checks alone does not authorize completion; all configured completion gates and required human approvals must also be satisfied.`,
  ].join("\n\n");
}
