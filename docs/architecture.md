# Architecture

Interlock is a tracker-to-agent dispatcher. It reads a tracker map, claims an
eligible ticket through the Git-remote claim lock, prepares a Git worktree, and
hands the ticket to an agent in a T3 Code lane. It separates that portable
coordination from tracker, workspace, and host mechanics. TypeScript domain
logic lives behind adapters; Bun-specific filesystem, SQLite, subprocess, and
executable behavior stays at platform boundaries.

## Code navigation

| Responsibility | Source |
| --- | --- |
| Action registration and service availability | [Application](../src/application.ts), [runtime services](../src/runtime-services.ts) |
| Input validation, invocation, help, completion | [CLI](../src/cli/) |
| Project requirements and personal choices | [Configuration](../src/configuration/), [starter TOML](../src/configuration/default.toml) |
| Entities, references, capabilities, adapter interfaces | [Domain](../src/domain/) |
| Read-only eligibility and stable selection | [Frontier](../src/frontier/) |
| Pickup, T3 launch plan, launch prompt | [Execution](../src/execution/) |
| Run history, receipts, recovery evidence | [Persistence](../src/persistence/) |
| Claim lock, Jira tracker, Git workspaces | [Adapters](../src/adapters/) |

Actions declare their inputs, description, handler, and availability together.
Invocation, help, completion, and the manual derive from those registrations.
Use `--help` for the available command surface. An adapter class or configuration
field alone does not establish an executable user workflow.

## Coordination

Claims live on the repository's Git remote as `refs/interlock/claims/<KEY>`;
the tracker mirrors the held lock and supplies dependency facts. The local SQLite
ledger records execution identity, snapshots, transaction steps, and recovery
evidence. JSON exports support inspection; they are not coordination stores.

Frontier evaluation consumes a complete normalized workspace graph and preserves
tracker order. Scope filters select results without dropping external blocker
facts. Reads do not claim tickets or advance workflow state.

Pickup completes capability and workspace preflights before claiming. Each
transition is recorded before the next side effect. See [claim semantics](claim-semantics.md)
for collision, compensation, and recovery behavior. A T3 Code lane runs the
agent; a finished agent turn does not establish ticket completion.

The pickup CLI uses `task/KEY` and `<worktree_root>/KEY`; the Git lock checks the
qualified ticket identity before that workspace can be prepared. Other Git
adapter callers retain the qualified identity encoding for paths and branches.
Preparation verifies the exact repository/path/branch mapping before reuse and
preserves dirty work. Deletion separately verifies ownership, canonical location,
registration, and a clean workspace. See the [Git adapter](../src/adapters/workspaces/git.ts).

## Contracts and decisions

- [Domain vocabulary](domain-model.md) and [claim semantics](claim-semantics.md).
- [Client/core ownership](ownership-boundary.md).
- Design rationale: [execution boundaries](adr/0001-lanes-environments-and-session-hosts.md),
  [tracker writes](adr/0002-tracker-write-minimalism.md), and
  [organization policy](adr/0003-organization-policy-and-enforced-configuration.md).

## Verification

Run the checks in [AGENTS.md](../AGENTS.md). Behavioral evidence lives in
[tests](../test/). The claim lock tests run against a real local bare remote;
Jira tests use an injected transport and do not qualify hosted tracker writes
or a live agent. The [pickup CLI test](../test/pickup-command.test.ts) runs the
registered command parser in subprocesses with real local Git locks/worktrees,
injected Jira and an injected GitHub origin identity. Platform and release checks are defined in the
[workflows](../.github/workflows/).
