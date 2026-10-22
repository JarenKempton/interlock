# ADR 0001: Execution boundaries

## Decision

Keep tracker, workspace, environment, agent invocation, and session hosting
separate. A session host may own several agent providers; it must not become
synonymous with one agent or model. Command invocations and structured host
requests need not share an argv-shaped interface.

Durable execution identity belongs to Interlock's ledger and tracker claims.
An orchestrator conversation or UI is a control surface, not a coordination
store. Closing a surface must not erase execution identity. Unattended progress
may use a supervisor; persistence must not depend on a daemon remaining alive.

Workspace strategy and execution isolation are separate choices. Strong
isolation runs the agent itself inside the selected environment. A host agent
issuing occasional container commands does not satisfy that requirement.
A sandbox-private clone and a host worktree are alternative strategies, not
mandatory duplicate copies. Workspace handles resolve in the selected
environment's frame of reference.

An explicit environment or isolation requirement cannot silently downgrade.
Provisioning can establish selectable integrations, but runtime preflight must
still verify availability and capabilities. Editors are optional presentation
tools, and desktop automation cannot substitute for a verified session API.

Project setup is declarative and provider-neutral. Runtime providers translate
the project contract; product-specific service topology remains adapter-owned.
Resource admission must respect configured concurrency and budgets before
starting additional work. Reuse does not relax ownership or readiness checks.

Grant source access, branch push, tracker writes, and merge authority separately.
Agents report through structured operations; prose does not authorize a state
transition. Validation and review evidence must identify the revision examined.
PR review automation belongs outside core, as an optional integration.

## Rationale

These boundaries allow different trackers, runtimes, hosts, and isolation
providers without changing claim semantics or making UI failure lose work.
They also prevent a requested isolation boundary from becoming cosmetic and
keep provider-specific policy out of portable coordination.

This decision constrains implementation; it does not advertise a lane protocol,
scheduler, sandbox provider, or command surface. Concrete interfaces live in
[domain contracts](../../src/domain/contracts.ts) and the
[environment boundary](../environment-boundary.md).
