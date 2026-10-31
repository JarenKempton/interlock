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

Qualification prevents collisions across tracker installations. A ticket
belongs to one map; its blockers can sit in other maps. A ticket lists its
blockers as `dependencies` and the tickets it blocks as `dependents`.

A claim names a human owner and a run, and retains the original tracker snapshot.
A run never substitutes for its human assignee. See [claim semantics](claim-semantics.md).

## Capabilities

Each boundary owns its vocabulary: `TrackerCapabilities`, `HostCapabilities`,
and the claim lock's `conditional_update`, the only entry in `CAPABILITIES`.
Identifiers are additive; published names cannot be repurposed. An adapter advertises only behavior it can verify; a
method's presence or successful authentication is not evidence. Operations
check the exact required set through `requireCapabilities`, which raises
`UnsupportedCapabilityError` before invoking anything.

## Tracker

[`Tracker`](../src/domain/tracker.ts) reads work and mirrors a claim the lock
already holds. `list_work` and `read` never mutate. `apply` installs the claim,
run and owner; `verify` checks an applied or restored mirror by readback;
`restore` returns the original snapshot and refuses to overwrite human changes.
Repeating `apply` or `restore` writes nothing. Trackers never claim or
release, and never advertise `conditional_update`. Optional `transition` and
`link_artifact` must be read back and idempotent.

## Claim lock

[`ClaimLock`](../src/domain/claim-lock.ts) owns `read`, `claim` and `release`, and is the only contract with version-checked writes. A competing
claim or stale version is a `ClaimCollisionError`; an outcome readback cannot
confirm is an `AmbiguousTrackerResultError`. Expiry never releases or reassigns.
See [claim semantics](claim-semantics.md).

## Host and lane

[`Host`](../src/domain/host.ts) requires `launch` and `locate`; message,
interrupt, focus, subagents and PR ownership are optional capabilities.
[`LaneProtocol`](../src/domain/lane.ts) defines `next`, `attach`, `submit`,
`verdict` and `done`, each returning a value or a refusal with a
machine-readable code. The lane state machine in the same module moves a lane
through queued, claimed, implementing, submitted, reviewing, approved, merged
and done; changes_requested loops back to implementing up to the lane's
configured round limit, then routes to attention, which resumes to the prior
state. Verdicts and evidence are bound to the submitted head and go stale for
any other head. `lane next` returns exactly one action for the lane's state.
Lanes persist in the local ledger, with or without a ticket; a one-off lane
can be promoted to a ticket. Merged lanes complete only after tracker
readback verifies the ticket is done, marking it done first when the
tracker's merge automation has not. Core owns the lane's one pull request:
`lane submit` pushes the head to the branch recorded for the lane's run
workspace through the user's own Git and `gh` auth, opens or adopts the
branch's pull request with the ticket key in its title, records the URL on
the lane and links it through the tracker's `link_artifact`, which for Jira is
one issue remote link keyed by the pull request URL and read back after the
write. A ticket lane with no signed-in tracker is refused as
`tracker_unavailable` before anything is pushed. Submit accepts only the exact
branch commit OID, binds Git and `gh --repo` to one verified push repository,
and retains the PR URL before attempting the tracker link. Existing PRs must
be open with a complete ticket key in their title; closed PRs are not replaced.

[`SubmissionAuthority`](../src/domain/submission.ts) reserves one create attempt
per ticket across machines in the recorded claim home. Its independent v1
Git record binds the lane/run/claim, repository and branch; it does not change
the v2 claim-record protocol. A verified atomic ref creation grants one
caller permission to create. Reservations are never expired, reassigned or
deleted, including by retirement. Later calls may adopt an existing PR but
cannot issue another create when the first outcome is unknown. A crash or
push/create failure after reservation may require manual reconciliation
(`recovery_required`); an absent GitHub search result is not proof that a
previous create failed. Local ledger locks alone are not this authority.
The [Git adapter](../src/adapters/submissions/git.ts) and
[isolated tests](../test/submission-authority.test.ts) define the contract.

This serializes core-managed creation, not GitHub itself: external actors can
still create PRs outside core, and GitHub search is eventually consistent.
The lane agent needs no GitHub write credential for submission; removing
ambient credentials from the lane environment remains the host's job. The `lane` actions and
[`LaneService`](../src/execution/lane.ts) expose the machine as commands.

## Conformance

[Tracker](../src/conformance/tracker.ts) and
[claim-lock](../src/conformance/claim-lock.ts) suites check collision,
stale-version refusal, readback, safe restoration, idempotence and ambiguous
writes. [Fakes](../test/conformance.test.ts), Jira and the Git lock run them.
