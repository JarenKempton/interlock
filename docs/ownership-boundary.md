# Client and core ownership

Interlock's CLI owns portable execution: normalized tracker reads, frontier
selection, claims, workspace preparation, configuration, launch, and recovery.
Adapters own vendor mechanics. The Git-remote claim lock decides ownership and
the tracker mirrors it; tracker facts remain durable coordination truth, and the
local ledger holds execution and recovery evidence.

T3 Code owns the lane: its conversation, agent provider, model, and the
in-thread MCP launch of the agent. A lane works one ticket in one worktree and
produces one pull request. Closing a lane does not release its claim.

Skills, MCP integrations, and other clients own presentation, map authoring,
role guidance, and translating a user's intent into an explicit operation.
Product Pipeline and other portfolio systems stay outside the execution core.
Clients must not infer success from a conversation or a progress message.

## Integration boundary

External clients invoke available public commands and request `--json` for
machine results. They must not import internal TypeScript modules, inspect the
SQLite database, call adapters directly, or parse human-formatted output.
Use generated `--help --json` to discover available actions and input contracts.
Output shapes belong to each action's definition.

### Pickup handoff

The in-thread T3 caller queries `orchestrator_capabilities` immediately before
pickup, including searches for configured models omitted from the short catalog.
It supplies the returned catalog as `{ "host": "t3", "observedAt": "<UTC ISO time>",
"catalog": <tool structured result> }` through `--t3-catalog PATH` or stdin with
`--t3-catalog -`. This is a trusted caller boundary: the CLI checks the supplied
catalog and its age (at most 60 seconds), not an independently authenticated T3
connection. Missing, stale, future-dated, disabled or ambiguous selections fail
before claiming. The caller must query again after a failure or delay.
The catalog age is checked again synchronously at claim-push dispatch, after
remote reads and local commit preparation. An expired catalog prevents that
push; this does not guarantee availability during the subsequent network call.

`pickup KEY --dry-run --json --t3-catalog PATH` reads configuration and Jira and
returns a plan without creating a ledger, workspace or claim. A mutating pickup
verifies the Git lock and Jira mirror, prepares `task/KEY` at
`<worktree_root>/KEY`, and records a `claimed` run. Its JSON `launch` object is
the argument object for `t3_thread_launch`, including `existing_worktree`, title,
message and model selection. The caller invokes that tool and retains its
returned thread identity; pickup does not launch an agent or claim it did.

Pickup checks frontier eligibility, hydrating blockers across maps before
claiming and again before writing the mirror. Unfinished or unreadable blockers
fail closed. Jira search supplies ordering; a subsequent direct issue read
supplies current fields, so search index lag cannot reopen completed tickets or
hide reopened blockers.

The implementer uses resolved personal/project settings unless
`[roles.implementer]` supplies `provider`, `model`, and optional `options`.
`[roles.reviewers.<lens>]` uses the same fields for each reviewer lens.
Every configured role is checked against exact provider instance/model IDs and
advertised option values. Required project settings apply to every role.
Inherited T3 model options apply only to the same provider instance and model;
an explicit options table replaces them. The plan's `reviewers` object carries
the verified choices for later reviews; pickup starts no reviewer.

Jira credentials come from `JIRA_USER_EMAIL` and `JIRA_API_TOKEN` in the process
environment. The site comes from project configuration; an optional `JIRA_SITE`
must match it. The authenticated Jira account owns the claim. Repository paths
and instruction paths resolve relative to the project TOML. Jira Rank and
priority metadata are discovered through read-only endpoints; unsupported
claim statuses fail closed.

`claim release CLAIM --json` uses the saved execution configuration and verifies
the authenticated owner, remote lock and restored Jira fields. It preserves the
workspace, including dirty work. Release does not require the ticket's current
parent map, Rank/priority discovery or the original workspace base branch.
A lost local release receipt can be retried;
an uncertain remote result remains `recovery_required`. `runs list`, `runs show`
and `runs export` expose local run evidence; export includes configuration,
claim, plan steps and recovery details. These commands accept `--state PATH`
when an explicit local ledger is needed. Closing a T3 thread is not release.
An uncertain Jira write's intended field value is retained in recovery evidence.
Release retries first verify that pending write completed; unchanged pre-write
state cannot establish restoration or authorize another write.

Selection must identify one ticket or an explicit selection policy. Secrets
cross through credential-provider handles or scoped secure channels, never
ordinary configuration, process arguments, logs, or receipts.

Public protocol changes remain backward compatible within a major. Consumers
must tolerate additive fields and handle unknown capabilities explicitly.
Unsupported operations and ambiguous outcomes must remain visible to the caller.
A client cannot synthesize a successful receipt or bypass recovery by directly
mutating the tracker.

## Workflow authority

Project instructions can guide work and define completion gates. Loading those
instructions proves what input was supplied, not that the agent obeyed it.
Session state, review approval, merge, and tracker completion are separate facts.
Generic launch prompts do not grant tracker mutation or merge authority.

PR review automation belongs in an optional integration consuming public
actions, with its workflow and permissions configured explicitly. Stopping
execution, releasing ownership, and deleting a workspace remain distinct operations.
