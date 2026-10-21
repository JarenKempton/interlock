# Client and core ownership

Interlock's CLI owns portable execution: normalized tracker reads, frontier
selection, claims, workspace preparation, configuration, launch, supervision,
and recovery. Adapters own vendor mechanics. Tracker facts remain durable
coordination truth; the local ledger holds execution and recovery evidence.

Skills, MCP integrations, and other clients own presentation, map authoring,
role guidance, and translating a user's intent into an explicit operation.
Product Pipeline and other portfolio systems stay outside the execution core.
Clients must not infer success from a conversation or a progress message.

## Integration boundary

External clients invoke available public commands and request `--json` for
machine results. They must not import internal TypeScript modules, inspect the
SQLite database, call adapters directly, or parse human-formatted output.
Use generated `--help --json` to discover available actions and input contracts.
Output shapes belong to each action's definition; the adapter protocol is a
separate versioned interface described in [adapter-protocol.md](adapter-protocol.md).

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
execution, releasing ownership, and deleting a workspace remain distinct actions.
