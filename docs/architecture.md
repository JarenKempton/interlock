# Architecture

Interlock separates portable coordination from tracker, workspace, environment,
and agent mechanics. TypeScript domain logic lives behind adapters; Bun-specific
filesystem, SQLite, subprocess, and executable behavior stays at platform boundaries.

## Code navigation

| Responsibility | Source |
| --- | --- |
| Action registration and service availability | [Application](../src/application.ts), [runtime services](../src/runtime-services.ts) |
| Input validation, invocation, help, completion | [CLI](../src/cli/) |
| Project requirements and personal choices | [Configuration](../src/configuration/), [starter TOML](../src/configuration/default.toml) |
| Entities, references, capabilities, adapter interfaces | [Domain](../src/domain/) |
| Read-only eligibility and stable selection | [Frontier](../src/frontier/) |
| Pickup, routing, supervision, lifecycle | [Execution](../src/execution/) |
| Run history, receipts, recovery evidence | [Persistence](../src/persistence/), [reconciliation](../src/reconciliation/) |
| Provider implementations | [Adapters](../src/adapters/) |

Actions declare their inputs, description, handler, and availability together.
Invocation, help, completion, and the manual derive from those registrations.
Use `--help` for the available command surface. An adapter class or configuration
field alone does not establish an executable user workflow.

## Coordination

The tracker supplies durable ownership and dependency facts. The local SQLite
ledger records execution identity, snapshots, transaction steps, and recovery
evidence. JSON exports support inspection; they are not coordination stores.

Frontier evaluation consumes a complete normalized workspace graph and preserves
tracker order. Scope filters select results without dropping external blocker
facts. Reads do not claim tickets or advance workflow state.

Pickup completes capability and workspace preflights before claiming. Each
transition is recorded before the next side effect. See [claim semantics](claim-semantics.md)
for collision, compensation, and recovery behavior. A finished agent turn does
not establish ticket completion.

Git workspaces use qualified ticket identity for deterministic paths and branches.
Preparation verifies the exact repository/path/branch mapping before reuse and
preserves dirty work. Deletion separately verifies ownership, canonical location,
registration, and a clean workspace. See the [Git adapter](../src/adapters/workspaces/git.ts).

## Contracts and decisions

- [Domain vocabulary](domain-model.md) and [external adapter protocol](adapter-protocol.md).
- [Client/core ownership](ownership-boundary.md) and [environment lifecycle](environment-boundary.md).
- [Command harnesses](harness-adapters.md) and [T3 integration](session-hosts/t3-adapter.md).
- Design rationale: [execution boundaries](adr/0001-lanes-environments-and-session-hosts.md),
  [tracker writes](adr/0002-tracker-write-minimalism.md), and
  [organization policy](adr/0003-organization-policy-and-enforced-configuration.md).

## Verification

Run the checks in [AGENTS.md](../AGENTS.md). Behavioral evidence lives in
[tests](../test/), including [compatibility fixtures](../test/fixtures/compatibility/)
and [disposable tracker acceptance](../test/disposable-tracker-acceptance.test.ts).
That acceptance suite uses a temporary Markdown tracker and an injected harness;
it does not qualify hosted tracker writes or a live agent. Platform and release
checks are defined in the [workflows](../.github/workflows/).
