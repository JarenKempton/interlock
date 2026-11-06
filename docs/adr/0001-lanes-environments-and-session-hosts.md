# ADR 0001: Execution boundaries

## Decision

Use the [domain vocabulary](../domain-model.md) at every boundary. Keep the
tracker, claim home, environment, host, harness and workspace separate.
Interlock dispatches one ticket to one lane: one lane ties its claim, workspace,
session and pull request together. T3 Code is the host; Claude Code, Codex and
Pi are harnesses. The host launches a harness session using a model and its
options. A client talks to Interlock; it is not the execution environment.

Place each project in exactly one environment: machine + isolation. A lane's
host, harness session, workspace and supervisor run together there. There is
one supervisor per environment, serving all projects placed there. Without
isolation that is one supervisor per machine. An isolated environment such as
a container runs its own host and supervisor inside it. The supervisor is the
planned long-running `interlock run` process, not an implemented capability.

Ownership belongs to the claim ref in the claim home, which the tracker only
mirrors. Claims coordinate across machines. Interlock's local ledger records
execution identity and recovery evidence. A session or client is not a
coordination store. Closing one must not erase ownership or execution identity;
claims must not depend on a supervisor remaining alive. Stopping a run must
not delete its workspace.

Preflight verifies host and harness availability before claiming. Gates wait
on external facts, not session completion. Editors are optional presentation
tools, and desktop automation cannot substitute for a verified host API.

Grant source access, branch push, tracker writes and merge authority separately.
Harness sessions report through structured operations; prose does not authorize
a state transition. Validation and review evidence identify the revision
examined. PR review automation is an optional integration outside core.

## Amendment: host launches

Lanes may also be launched by a core process through a verified host CLI,
without an agent in the loop. The launch follows the same claim-before-work
order: host preflight runs before claiming, and the launch is the first host
side effect after the claim. The host may create the workspace on a host
launch; Interlock verifies and records it before work. The host must be
verified by version and readback, not assumed; on failure the launch refuses
and never falls back to another host or a headless harness. One claim gets at
most one launch, and an unresolved launch keeps the claim for recovery.

## Rationale

A Git ref gives every tracker the same conditional claim, including trackers
without compare-and-swap, and survives the loss of a session or machine. Keeping
the host separate lets lanes change harnesses or models without changing claim
semantics. Explicit placement prevents a workspace on one machine from silently
being paired with a host or supervisor on another. Keeping all lane processes
inside its isolation boundary makes that boundary meaningful.

This decision constrains implementation; it does not advertise commands.
Concrete interfaces live in [domain contracts](../../src/domain/contracts.ts)
and [claim semantics](../claim-semantics.md).
