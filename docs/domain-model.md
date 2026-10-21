# Domain vocabulary

[Domain types](../src/domain/model.ts), [reference validation](../src/domain/reference.ts),
and [adapter interfaces](../src/domain/contracts.ts) define the portable contract.
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
| claim | `interlock-claim:<id>` | Tracker coordination identity |

Qualification prevents collisions across tracker installations. Dependency
evaluation can cross maps within a workspace; protocol 1.x rejects evaluation
across workspaces. A ticket belongs to one map. Group nesting and native tracker
references do not change frontier or ownership rules.

A claim names a human owner and a run, and retains the original tracker snapshot.
A run never substitutes for its human assignee. See [claim semantics](claim-semantics.md).

## Capabilities

`CAPABILITIES` in the domain model is the authoritative vocabulary. Identifiers
are additive within a protocol major; published names cannot be repurposed.
An adapter advertises only behavior its implementation and runtime can verify.

Presentation tiers summarize capabilities. Operations check the exact required
set through `requireCapabilities`; missing support raises
`UnsupportedCapabilityError` before invoking the operation. Executable discovery,
UI visibility, and successful authentication do not establish lifecycle or
conditional-mutation guarantees.
