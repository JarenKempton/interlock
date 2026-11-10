# ADR 0003: A supervisor on the journal, not a workflow engine

## Decision

`interlock run` is a polling supervisor built on the local ledger. Each tick
re-reads the tracker, the Git-remote claim refs, GitHub and the host, then
advances only gates whose fact is true now: complete merged lanes, resume
stalled sessions, then launch unblocked frontier tickets up to a parallelism
limit. Every side effect goes through an existing journaled operation
(`lane complete`, `pickup --launch`, `lane attention`) or is journaled under its
[operation identity](../domain-model.md#engine-ready-contracts) before it runs.
A pending effect without a recorded outcome is never repeated; it is routed to
attention. One supervisor runs per environment, enforced by a ledger lock.

We do not adopt Temporal now. Its TypeScript SDK does not run on Bun
([temporalio/sdk-typescript#2627](https://github.com/temporalio/sdk-typescript/issues/2627)),
and Interlock's runtime and single executable are Bun. Running a separate
Node worker and a Temporal service would add two runtimes for a single-user,
single-machine loop whose truth already lives in the tracker, the claim refs
and GitHub.

## Revisit when

- Temporal's Bun issue #2627 is fixed, or
- lanes must be scheduled from a queue shared across machines.

Restate is the first candidate then: its TypeScript SDK targets Bun, and its
journaled handlers map onto the existing `[lane, step]` operation identity.

## Rationale

The supervisor's durable state is small: which gate facts were observed, and
which non-idempotent host messages were attempted. The ledger already journals
every tracker and claim write, so a restart at any point replays from the
journal plus fresh reads instead of from workflow history. Human edits win
because every tick reads the ticket, its blockers and the remote claim before
acting; the supervisor never releases or reassigns a claim, expired or not.
