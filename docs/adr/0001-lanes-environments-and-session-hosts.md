# ADR 0001: Execution boundaries

## Decision

Keep the tracker, the claim lock, the workspace, and the agent host separate.
Interlock dispatches one ticket to one T3 Code lane: one lane works one ticket
in one Git worktree and produces one pull request. T3 Code launches the lane's
agent through in-thread MCP. A host may run several agent providers; it must
not become synonymous with one agent or model.

Ownership belongs to the Git-remote claim lock, `refs/interlock/claims/<KEY>`,
which the tracker mirrors. Interlock's local ledger records execution identity
and recovery evidence. A lane's conversation or UI is a control surface, not a
coordination store. Closing it must not erase ownership or execution identity,
and claims must not depend on a daemon remaining alive.

Runtime preflight must verify host and agent availability before claiming.
Editors are optional presentation tools, and desktop automation cannot
substitute for a verified host API.

Grant source access, branch push, tracker writes, and merge authority separately.
Agents report through structured operations; prose does not authorize a state
transition. Validation and review evidence must identify the revision examined.
PR review automation belongs outside core, as an optional integration.

## Rationale

A Git ref gives every tracker the same conditional claim, including trackers
without compare-and-swap, and survives the loss of any lane or machine. Keeping
the host separate lets lanes change providers or models without changing claim
semantics, and keeps provider-specific policy out of portable coordination.

This decision constrains implementation; it does not advertise a command
surface. Concrete interfaces live in [domain contracts](../../src/domain/contracts.ts)
and [claim semantics](../claim-semantics.md).
