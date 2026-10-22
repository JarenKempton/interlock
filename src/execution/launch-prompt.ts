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
export interface LaunchPromptOptions {
  roleTemplate?: string;
  runtimeContract?: string;
  tracker?: string;
  context?: string;
}
export function buildLaunchPrompt(ticket: Ticket, options: LaunchPromptOptions = {}): string {
  const criteria = ticket.acceptanceCriteria ?? acceptanceCriteria(ticket.description ?? "");
  return [
    ...(options.runtimeContract ? [`Read the runtime contract:\n${options.runtimeContract}`] : []),
    ...(options.tracker ? [`Tracker:\n${options.tracker}`] : []),
    `Map:\n${ticket.map}`,
    `Ticket:\n${ticket.ref}${ticket.title ? ` — ${ticket.title}` : ""}`,
    `Role:\n${ticket.kind}`,
    `Role guidance:\n${options.roleTemplate ?? ROLE_TEMPLATES[ticket.kind]}`,
    `Description:\n${ticket.description ?? "Not supplied by tracker."}`,
    `Acceptance criteria:\n${criteria ?? "Not supplied by tracker; verify with the ticket owner before completion."}`,
    "Required output:\n- Report the work performed and link any resulting artifacts.\n- Report acceptance evidence, unverified criteria, and remaining blockers.",
    "Authorization and completion:\nThis prompt does not grant authority to mutate tracker state, close tickets, or update maps. Follow the project/workflow instructions and explicit authorization for those actions. Passing acceptance checks alone does not authorize completion; all configured completion gates and required human approvals must also be satisfied.",
    ...(options.context ? [`Session-specific instructions:\n${options.context}`] : []),
  ].join("\n\n");
}
