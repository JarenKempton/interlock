# Domain vocabulary

[Domain types](../src/domain/model.ts) and [reference validation](../src/domain/reference.ts)
define portable identity. The TypeScript contracts below define adapter behavior.
Adapters translate vendor objects into these terms.

## Identity

| Kind | Form | Meaning |
| --- | --- | --- |
| tracker | `<adapter>:<instance>` | One configured tracker installation |
| workspace | `<tracker-ref>:<workspace-id>` | Dependency and policy boundary |
| group | `<workspace-ref>:group:<native-id>` | Optional container of maps |
| map | `<workspace-ref>:map:<native-id>` | Ordered collection of tickets |
| ticket | `<workspace-ref>:ticket:<native-id>` | One unit of work |
| run | `interlock-run:<id>` | Local execution identity |
| claim | `interlock-claim:<id>` | Ownership identity held by the claim lock and mirrored by the tracker |

Qualification prevents collisions across tracker installations. Dependency
evaluation can cross maps within a workspace; Interlock rejects evaluation
across workspaces. A ticket belongs to one map. Group nesting and native tracker
references do not change frontier or ownership rules.

A claim names a human owner and a run, and retains the original tracker snapshot.
A run never substitutes for its human assignee. See [claim semantics](claim-semantics.md).

## Capabilities

Capability vocabularies belong to their boundary: `TrackerCapabilities`,
`HostCapabilities`, and the claim lock's `conditional_update`. The execution
model's `CAPABILITIES` retains existing published names for compatibility;
those names do not confer ownership guarantees on a tracker. Identifiers are
additive within a protocol major and cannot be repurposed.

An adapter advertises only behavior its implementation and runtime can verify.
Callers check a capability before invoking an optional operation. A method's
presence, executable discovery, UI visibility, or successful authentication is
not capability evidence. Unknown capabilities do not authorize an operation.

## Tracker

[Tracker contracts](../src/domain/tracker.ts) separate read access from claim
mirroring. `TrackerReader.list_work(map)` preserves tracker order and returns
normalized tickets; `read(ticket)` returns the ticket, an opaque restoration
snapshot, and artifact URLs. These reads never claim work or advance status.
The snapshot's revision is evidence for the tracker, not a conditional lock
version. Consumers must not infer compare-and-swap from it.

`TrackerMirror.apply` mirrors an already-held lock's claim, run, and human owner.
`verify` explicitly distinguishes applied from restored expectations. `restore`
uses the original snapshot and persisted claimed owner, preserves concurrent
human changes, and refuses restoration it cannot safely verify. Repeating an
applied mirror or completed restoration performs no additional write.

Only a verified, explicitly authorized lock replacement permits the coordinator
to pass `supersedes` to `apply`. That field identifies the previous mirror;
it is not independent authority to overwrite ownership. Trackers have no claim,
renew, or release operations and never advertise `conditional_update` or
`atomic_assignment`.

`transition` and `link_artifact` are optional. Their capabilities require
idempotence and readback of the resulting status or artifact link. Success from
a write endpoint alone is insufficient. Unreadable or unconfirmed outcomes
remain ambiguous errors; callers retain recovery evidence instead of treating
them as a definite failure with no side effects. Claim metadata stays structured;
these contracts neither require comments nor authorize narrative tracker writes.

## Claim lock

[Claim-lock contracts](../src/domain/claim-lock.ts) own `read`, `claim`, `renew`,
and `release`. Only this boundary advertises version-checked writes. Every write
must match the observed lock version and applicable claim/owner identity. A
competing claimant or stale version is a `ClaimCollisionError`; an outcome that
cannot be determined by readback is an `AmbiguousTrackerResultError` (the existing
error code is retained across the lock boundary).

`RecoverableClaimLock` adds the existing guarded `releasable`, compensation
`restore`, and explicit authorized `reclaim` operations for coordination paths
that use them. Minimal adapters need not implement this extension. Expiry is
observational: it never releases or reassigns ownership. See
[claim semantics](claim-semantics.md) for ordering and recovery guarantees.

## Host

[Host contracts](../src/domain/host.ts) require `launch` and `locate` with stable
run identity, ticket, workspace, and session identity. Retrying launch for the
same run locates the same session; reusing a run with a different ticket or
workspace refuses. A lost launch response must not cause a duplicate launch.

Message delivery, interrupt, focus, subagent discovery, and PR ownership are
optional capabilities. Each needs independently observed behavior: a delivered
message, verified stopped session, focused session, actual child sessions, or
an ownership check that rejects an unrelated PR. Interrupting a host session
does not release a claim or delete a workspace. This is an ordinary TypeScript
boundary, with no generic plugin transport or host-specific HTTP protocol.

## Lane protocol

[Lane contracts](../src/domain/lane.ts) define `next`, `attach`, `submit`,
`verdict`, and `done`. `next` reads the first eligible ticket under an explicit
map selection policy. `attach` associates an existing claim/run/ticket with a
host session. Submission and verdict carry the artifact revision and gate
evidence so completion can reject stale evidence. These types do not implement
the lane state machine or grant completion authority.

Every operation returns either `{ ok: true, value }` or
`{ ok: false, refusal: { code, message } }`. Refusal codes distinguish collision,
stale version/evidence, missing capability/artifact/gates, invalid transition,
ambiguous write, and required recovery. Clients branch on codes, never prose;
unknown codes must remain refusals.

## Adapter conformance

The portable [runner](../src/conformance/runner.ts) executes the
[tracker](../src/conformance/tracker.ts), [claim-lock](../src/conformance/claim-lock.ts),
and [host](../src/conformance/host.ts) suites. Adapter authors supply fresh,
isolated fixtures, independent observations of side effects, and transport fault
injection after writes. Fixtures must never target live tickets or sessions.
The runner reports each behavioral failure and does not depend on Bun or a test
framework. [Executable examples](../test/conformance.test.ts) include conforming
fakes and deliberately broken implementations.

Passing shape checks or a happy path does not qualify an adapter. Conformance
requires collision exclusion, stale-version refusal, exact readback, safe
restoration, idempotence, and explicit ambiguous outcomes. Optional capabilities
are exercised only when advertised, and a passing fake does not certify a live
transport or host runtime.
