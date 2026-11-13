import { type GateEvidence, trackerSource } from "../../domain/gate/evidence.ts";
import type { Ticket } from "../../domain/tracker/ticket.ts";
import type { RemoteClaim, SupervisedLane, SupervisorPorts } from "./ports.ts";

export type HumanHold = "reassigned" | "reopened" | "reblocked" | "claim_changed";

export interface HoldReading {
  hold: HumanHold | undefined;
  evidence: GateEvidence[];
}

export async function readHumanEdits(
  ports: Pick<SupervisorPorts, "read" | "remoteClaim">,
  supervised: SupervisedLane,
  observedAt: string,
): Promise<HoldReading> {
  const { lane, claim } = supervised;
  if (!lane.ticket) return { hold: undefined, evidence: [] };
  if (!claim)
    return {
      hold: "claim_changed",
      evidence: [claimEvidence({ claim: undefined, source: "unrecorded" }, observedAt)],
    };
  const ticket = await ports.read(lane.ticket);
  const remote = await ports.remoteClaim(supervised);
  const open = await openBlockers(ports, ticket);
  const tracker = trackerSource(lane.ticket);
  const evidence: GateEvidence[] = [
    {
      gate: "assignee",
      fact: "ticket_assigned_to_claim_owner",
      source: tracker,
      observed: { value: ticket.assignee ?? null },
      observedAt,
    },
    {
      gate: "status",
      fact: "ticket_in_claimed_status",
      source: tracker,
      observed: { value: ticket.status },
      observedAt,
    },
    {
      gate: "blockers",
      fact: "blockers_closed",
      source: tracker,
      observed: { value: open.length ? open.join(",") : true },
      observedAt,
    },
    claimEvidence(remote, observedAt),
  ];
  return { hold: holdFor(supervised, ticket, remote, open.length > 0), evidence };
}

function holdFor(
  { claim, claimedStatus }: SupervisedLane,
  ticket: Ticket,
  remote: RemoteClaim,
  blocked: boolean,
): HumanHold | undefined {
  if (remote.claim !== claim?.ref) return "claim_changed";
  if (ticket.assignee !== claim?.humanOwner) return "reassigned";
  if (ticket.state !== "closed" && claimedStatus && ticket.status !== claimedStatus)
    return "reopened";
  if (blocked) return "reblocked";
  return undefined;
}

export function claimEvidence(remote: RemoteClaim, observedAt: string): GateEvidence {
  return {
    gate: "claim",
    fact: "claim_held_by_lane",
    source: { system: "git", ref: remote.source },
    observed: { value: remote.claim ?? null },
    observedAt,
  };
}

async function openBlockers(ports: Pick<SupervisorPorts, "read">, ticket: Ticket) {
  const open: string[] = [];
  for (const dependency of ticket.dependencies ?? []) {
    if ((await ports.read(dependency.blocking)).state !== "closed") open.push(dependency.blocking);
  }
  return open;
}
