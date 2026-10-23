# Domain vocabulary

[Domain types](../src/domain/model.ts), [reference validation](../src/domain/reference.ts),
and the contracts below define the portable contract. Adapters translate vendor objects into these terms.

## Identity

| Kind | Form | Meaning |
| --- | --- | --- |
| tracker | `<adapter>:<instance>` | One configured tracker installation |
| workspace | `<tracker-ref>:<workspace-id>` | Dependency and policy boundary |
| group | `<workspace-ref>:group:<native-id>` | Optional container of maps |
| map | `<workspace-ref>:map:<native-id>` | Ordered collection of tickets |
| ticket | `<workspace-ref>:ticket:<native-id>` | One unit of work |
| run | `interlock-run:<id>` | Local execution identity |
| claim | `interlock-claim:<id>` | Ownership held by the claim lock, mirrored by the tracker |

Qualification prevents collisions across tracker installations. Dependency
evaluation can cross maps within a workspace; Interlock rejects evaluation
across workspaces. A ticket belongs to one map. Group nesting and native tracker
references do not change frontier or ownership rules.

A claim names a human owner and a run, and retains the original tracker snapshot.
A run never substitutes for its human assignee. See [claim semantics](claim-semantics.md).

## Capabilities

Each boundary owns its vocabulary: `TrackerCapabilities`, `HostCapabilities`,
and the claim lock's `conditional_update`. `CAPABILITIES` in the domain model
keeps existing published names. Identifiers are additive; published names
cannot be repurposed. An adapter advertises only behavior it can verify; a
method's presence or successful authentication is not evidence. Operations
check the exact required set through `requireCapabilities`, which raises
`UnsupportedCapabilityError` before invoking anything.

## Tracker

[`Tracker`](../src/domain/tracker.ts) reads work and mirrors a claim the lock
already holds. `list_work` and `read` never mutate. `apply` installs the claim,
run and owner; `verify` checks an applied or restored mirror by readback;
`restore` returns the original snapshot and refuses to overwrite human changes.
Repeating `apply` or `restore` writes nothing. `supersedes` is set only for an
authorized lock replacement. Trackers never claim, renew or release, and never
advertise `conditional_update`. Optional `transition` and `link_artifact` must
be read back and idempotent.

## Claim lock

[`ClaimLock`](../src/domain/claim-lock.ts) owns `read`, `claim`, `renew` and
`release`, and is the only contract with version-checked writes. A competing
claim or stale version is a `ClaimCollisionError`; an outcome readback cannot
confirm is an `AmbiguousTrackerResultError`. Expiry never releases or reassigns.
See [claim semantics](claim-semantics.md).

## Host and lane

[`Host`](../src/domain/host.ts) requires `launch` and `locate`; message,
interrupt, focus, subagents and PR ownership are optional capabilities.
[`LaneProtocol`](../src/domain/lane.ts) defines `next`, `attach`, `submit`,
`verdict` and `done`, each returning a value or a refusal with a
machine-readable code. Both are types only until a host and lane state machine
implement them.

## Conformance

[Tracker](../src/conformance/tracker.ts) and
[claim-lock](../src/conformance/claim-lock.ts) suites check collision,
stale-version refusal, readback, safe restoration, idempotence and ambiguous
writes. [Fakes](../test/conformance.test.ts), Jira and the Git lock run them.
