# Architecture

Interlock is a tracker-to-agent dispatcher. It reads a ticket and its blockers,
claims it through the Git-remote claim lock, prepares a Git worktree, and
returns the arguments a T3 Code lane uses to launch an agent on it. It separates that portable
coordination from tracker, workspace, and host mechanics. TypeScript domain
logic lives behind adapters; Bun-specific filesystem, SQLite, subprocess, and
executable behavior stays at platform boundaries.

## Code navigation

| Responsibility                                         | Source                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Action registration and runtime services               | [Application](../src/application.ts), [runtime services](../src/runtime-services.ts)                      |
| Input validation, invocation, help, completion         | [CLI](../src/cli/)                                                                                        |
| Shared tracker facts and user settings                 | [Configuration](../src/configuration/), [starter TOML](../src/configuration/default.toml)                 |
| Entities, references, capabilities, adapter interfaces | [Domain](../src/domain/)                                                                                  |
| Adapter conformance suites                             | [Conformance](../src/conformance/)                                                                        |
| Pickup, T3 launch plan, launch prompt                  | [Execution](../src/execution/)                                                                            |
| Run history, receipts, recovery evidence               | [Persistence](../src/persistence/)                                                                        |
| Claim lock, Jira tracker, Git workspaces               | [Adapters](../src/adapters/)                                                                              |
| T3 host port through the t3 CLI                        | [T3 host adapter](../src/adapters/hosts/t3/), [host launch](../src/execution/pickup/)                     |
| Supervisor tick, wiring, status and user service       | [Supervisor](../src/execution/supervisor/), [app](../src/app/), [service](../src/distribution/service.ts) |

Actions declare their inputs, description, and handler together.
Invocation, help, completion, and the manual derive from those registrations.
Use `--help` for the available commands. An adapter class or configuration
field alone does not establish an executable user workflow.

## Target tree and naming

The target layout below is enforced incrementally; existing files are not moved
by the toolchain migration. JWB-944 reorganizes them. Concept folders are singular,
adapter categories plural, and vendor names occur only under `adapters/`.

```text
src/
  main.ts
  app/                         application, runtime services, tracker registry
  domain/<concept>/            refs, tracker, claim, lane, submission, operation, gate, host
  execution/<use-case>/        pickup, claim, lane
  adapters/
    trackers/<vendor>/
    git/
    github/
    hosts/t3/
  conformance/
  cli/
  mcp/
  configuration/
  persistence/
  sign-in/
  distribution/
test/                          mirrors src/ path for path
  fixtures/<concept>/
```

Files and folders use kebab-case; types use PascalCase and methods camelCase.
Use snake_case only on the wire and in configuration. A filename does not repeat
its containing folder's name. Tests mirror source paths; fixtures group by concept.
Handwritten code folders under `src/`, `test/`, `scripts/`, and `tooling/` contain
at most 12 files. Generated `src/persistence/migrations/` is exempt. The independent
site project and generated contracts are outside the CLI lint scope.

| Layer       | Allowed dependencies across layers                 |
| ----------- | -------------------------------------------------- |
| domain      | domain and zod only; no platform or vendor imports |
| execution   | domain only                                        |
| adapters    | domain and shared adapter helpers; never execution |
| persistence | domain                                             |
| cli, mcp    | app and execution                                  |
| app         | any layer                                          |

Imports within the same layer are allowed, but no import cycles are allowed.
Other support layers retain their existing dependencies until their contracts are
narrowed. The entry point imports app. Boundary classification uses directories,
not filename heuristics, and resolves TypeScript imports through
`eslint-import-resolver-typescript`.

[Vite+ configuration](../vite.config.ts) enables native Oxlint filename, cycle,
and strict TypeScript rules, `eslint-plugin-boundaries`, and the local
[structure plugin](../tooling/structure.mjs). Existing violations are explicitly
listed by rule and file in [the baseline](../tooling/lint-baseline.json); only those
file/rule pairs are exempt. An already oversized folder lists its existing members,
not an increased limit, so adding another file fails. New code must satisfy the
rules without growing exemptions. Remove entries when fixing or deleting files.
The baseline rule compares against `INTERLOCK_LINT_BASE` in CI (the PR base branch,
or the previous commit on main), and `HEAD` locally. A missing/unreadable comparison
fails closed; the initial Biome-to-Oxlint migration is the sole bootstrap case.

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
`lane complete --ticket KEY` verifies GitHub merge proof at the approved head,
re-checks remote claim ownership before tracker mutation, and journals recovery
through the verified Done readback and persisted success receipt. Completion
removes the tracker mirror and releases the claim while preserving the workspace;
`lane attach` remains mandatory before work.

Pickup prepares `task/KEY` at `<worktree_root>/KEY`. A new branch starts, untracked,
at the origin's default branch as fetched just before claiming, never at the
possibly stale local branch of the same name. Preparation verifies the
exact repository/path/branch mapping before reuse and preserves dirty work.
Interlock never deletes a workspace. See the [Git adapter](../src/adapters/workspaces/git.ts).
With `pickup --launch`, the T3 host creates `task/KEY` from the fetched origin
base commit instead, and pickup records the worktree it reports; see the
[host capability](domain-model.md#engine-ready-contracts).

## Contracts and decisions

- [Domain vocabulary](domain-model.md) and [claim semantics](claim-semantics.md).
- [Client/core ownership](ownership-boundary.md).
- Design rationale: [execution boundaries](adr/0001-lanes-environments-and-session-hosts.md),
  [tracker writes](adr/0002-tracker-write-minimalism.md) and
  [the supervisor on the journal](adr/0003-supervisor-on-the-journal.md).

Tracker, claim-lock and lane contracts are plain TypeScript interfaces;
see the [domain model](domain-model.md#tracker).

Only [claim-record v2](../contracts/claim-record.v2.json) is frozen. Its
[minimal generator](../src/conformance/claim-record.ts) and
[byte-freeze tests](../test/claim-record-contract.test.ts) protect the schema
and reader fixtures. Action surfaces, settings and TOML are unstable before
1.0; there is no action compatibility classifier or historical schema archive.
Every action still declares a zod `result`; a mismatch fails before rendering
or returning it. [JSON output snapshots](../test/execution/outputs.test.ts)
exercise the current pickup and lane handoff through the CLI. Deliberate
changes update those snapshots in the same change, without minting a major.
Migration hashes remain independent: `vp run db:hash` only adds new migrations.

Engine-ready domain contracts live in `domain/operation/identity.ts`,
`domain/gate/evidence.ts` and `domain/host/capability.ts`. They define stable
side-effect identity, external gate facts and host session operations. See
[their semantics](domain-model.md#engine-ready-contracts) and the
[supervisor](domain-model.md#supervisor) that uses them.

## Verification

Run the checks in [AGENTS.md](../AGENTS.md). Behavioral evidence lives in
[tests](../test/). The claim lock tests run against a real local bare remote;
Jira tests use an injected transport and do not qualify hosted tracker writes
or a live agent. The [pickup CLI test](../test/pickup-command.test.ts) runs the
registered command parser in subprocesses with real local Git locks/worktrees,
injected Jira and an injected GitHub origin identity. Platform and release checks are defined in the
[workflows](../.github/workflows/).
