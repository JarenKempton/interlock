# Architecture

Interlock is a tracker-to-agent dispatcher. It reads a ticket and its blockers,
claims it through the Git-remote claim lock, prepares a Git worktree, and
returns the arguments a T3 Code lane uses to launch an agent on it. It separates that portable
coordination from tracker, workspace, and host mechanics. TypeScript domain
logic lives behind adapters; Bun-specific filesystem, SQLite, subprocess, and
executable behavior stays at platform boundaries.

## Code navigation

| Responsibility | Source |
| --- | --- |
| Action registration and runtime services | [Application](../src/application.ts), [runtime services](../src/runtime-services.ts) |
| Input validation, invocation, help, completion | [CLI](../src/cli/) |
| Shared tracker facts and user settings | [Configuration](../src/configuration/), [starter TOML](../src/configuration/default.toml) |
| Entities, references, capabilities, adapter interfaces | [Domain](../src/domain/) |
| Adapter conformance suites | [Conformance](../src/conformance/) |
| Pickup, T3 launch plan, launch prompt | [Execution](../src/execution/) |
| Run history, receipts, recovery evidence | [Persistence](../src/persistence/) |
| Claim lock, Jira tracker, Git workspaces | [Adapters](../src/adapters/) |

Actions declare their inputs, description, and handler together.
Invocation, help, completion, and the manual derive from those registrations.
Use `--help` for the available command surface. An adapter class or configuration
field alone does not establish an executable user workflow.

## Coordination

Claims live on the repository's Git remote as `refs/interlock/claims/<KEY>`;
the tracker mirrors the held lock and supplies dependency facts. The local SQLite
ledger records execution identity, snapshots, transaction steps, and recovery
evidence. JSON exports support inspection; they are not coordination stores.

Pickup reads the ticket and each direct blocker, in any map; an unfinished or
unreadable blocker stops it. Reads do not claim tickets or advance workflow state.

Pickup completes capability and workspace preflights before claiming. Each
transition is recorded before the next side effect. See [claim semantics](claim-semantics.md)
for collision, compensation, and recovery behavior. A T3 Code lane runs the
agent; a finished agent turn does not establish ticket completion.

Pickup prepares `task/KEY` at `<worktree_root>/KEY`. Preparation verifies the
exact repository/path/branch mapping before reuse and preserves dirty work.
Interlock never deletes a workspace. See the [Git adapter](../src/adapters/workspaces/git.ts).

## Contracts and decisions

- [Domain vocabulary](domain-model.md) and [claim semantics](claim-semantics.md).
- [Client/core ownership](ownership-boundary.md).
- Design rationale: [execution boundaries](adr/0001-lanes-environments-and-session-hosts.md)
  and [tracker writes](adr/0002-tracker-write-minimalism.md).

Tracker, claim-lock and lane contracts are plain TypeScript interfaces;
see the [domain model](domain-model.md#tracker).

Public surfaces are frozen as JSON Schema under [`contracts/`](../contracts/):
each action's input and output (one snapshot covers its MCP tool and CLI
`--json`), `interlock.toml`, user and personal settings, and the claim record.
Every action declares a zod `result`; a result that does not match fails the
action before anything is rendered or returned. `bun run contracts:write`
regenerates the current major's snapshot from zod and hashes it in
`contracts/hashes.json`. Schemas repeated across snapshots live once in
`contracts/definitions.json`, keyed by the SHA-256 of their resolved content
and referenced by `$ref`; comparisons resolve them first, so a change to a
shared schema is reported for every surface that uses it. The writer refuses a
breaking change, and so does
`bun run contracts:check <base-ref>` in CI: a removed or renamed field, a newly
required field, a narrowed type or a removed enum value needs a new major
(`version` on the action, or the surface's version constant), and every earlier
snapshot stays hash-locked. Additive optional changes rewrite the current
major. The rules are in the [classifier](../src/conformance/contract-diff.ts).
`bun run db:hash` likewise only adds hashes for new migrations.

## Verification

Run the checks in [AGENTS.md](../AGENTS.md). Behavioral evidence lives in
[tests](../test/). The claim lock tests run against a real local bare remote;
Jira tests use an injected transport and do not qualify hosted tracker writes
or a live agent. The [pickup CLI test](../test/pickup-command.test.ts) runs the
registered command parser in subprocesses with real local Git locks/worktrees,
injected Jira and an injected GitHub origin identity. Platform and release checks are defined in the
[workflows](../.github/workflows/).
