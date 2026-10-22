# Claim and recovery semantics

[Pickup](../src/execution/pickup.ts), the [Git claim lock](../src/adapters/claims/git-lock.ts),
and [claim types](../src/domain/model.ts) implement these transitions.
[Claim tests](../test/claim.test.ts), [pickup tests](../test/pickup.test.ts),
and [lock tests](../test/git-claim-lock.test.ts) exercise failure paths.

## Identity and leases

Tracker assignment names the responsible human. A run identifies one execution;
a claim binds that run, ticket, and owner to an exact pre-claim snapshot.
Local state alone never establishes ownership.

| Claim state | Meaning |
| --- | --- |
| `active` | Current claim with an unexpired lease |
| `stale` | Lease expired; derived by reading time, with no mutation |
| `released` | Explicit, verified restoration of the pre-claim fields |
| `superseded` | Explicit stale reclaim installed a successor identity |

Renewal requires a matching active claim and extends its lease under the
current lock version. Expiry never authorizes automatic renewal, release, or
reassignment.

Reclaim requires authorization, the stale claim identity, a fresh read, and a
conditional write. A mismatch is a collision. The successor retains the original
pre-claim snapshot and predecessor identity for later restoration and audit.

## Release and recovery

Release explicitly returns ownership by conditionally restoring and verifying
the original claim-related fields. The ticket re-enters the frontier only if
the restored state is eligible. Closing a lane, stopping an agent, and deleting
a workspace are separate from release.

A run whose side effects could not be verified stays `recovery_required` with
its evidence in the ledger; `interlock runs export` shows it. A flag or human
assertion is not itself proof of the remote outcome.

## Pickup and compensation

Pickup persists each transition before beginning the next side effect:

The executable T3 pickup stops after workspace preparation and records the run
as `claimed`, with launch arguments in its plan. It does not connect T3 to the
generic launch/stop path below. Preflights are read-only; the local recovery
intent (including the original snapshot) is journaled before the first remote
claim write. No workspace or agent side effect precedes the verified lock and
Jira mirror. Verified compensation marks the run `compensated` and its local
claim `released`; an uncertain outcome retains recovery evidence.

| From | Operation | Verified result | Failure path |
| --- | --- | --- | --- |
| `planning` | Complete preflights; capture snapshot | `claiming` | No tracker mutation |
| `claiming` | Conditional claim and readback | `claimed` | Definite collision ends `collision`; ambiguous result enters compensation |
| `claimed` | Prepare workspace | `workspace_prepared` | Compensation |
| `workspace_prepared` | Launch agent | `launched` | Compensation, including a partial launch receipt |
| `launched` | Persist active run and receipt | `committed` | Compensation |

The generic coordinator persists `compensating`, attempts to stop a recorded
launch, then attempts guarded restoration and readback of the original tracker
snapshot. It attempts restoration even if stop fails. Only verified side-effect
resolution permits `compensated`; uncertain stop, restoration, or persistence
produces `recovery_required`.

That compensation behavior is unsafe for a host that may commit a launch
without returning a receipt or cannot verify stop. Such a host must not be
connected to generic pickup without a recovery path that retains ownership
and prevents duplicate launch.

## Git-remote claim lock

Trackers without a conditional write, such as Jira Cloud, claim through an
append-only lock ref on the repository's Git remote:
[`GitClaimLock`](../src/adapters/claims/git-lock.ts), composed with the tracker
by [`GitLockedTrackerAdapter`](../src/adapters/claims/locked-tracker.ts).

- The ref is `refs/interlock/claims/<KEY>`, validated by `git check-ref-format`.
  There is no fallback namespace: a host that rejects `refs/interlock/*` fails
  the claim with its own rejection.
- Claim, renew, release and reclaim each append one commit whose message holds
  the claim record, built on the observed tip and sent with an ordinary
  fast-forward push. The remote applies it only while the ref is still at that
  tip, and claim creates the ref only while it is absent. A losing writer gets
  `ClaimCollisionError`. Forced pushes, hook bypasses and ref deletion are never used.
- The lock version is the tip commit, or `absent`. It is the snapshot version
  that claim, renewal and release must match.
- A push that fails without a definite rejection is resolved with
  `git ls-remote` and the tip's record: our commit means it landed; a different
  tip means a collision; an unchanged tip or an unreadable remote remains
  `AmbiguousTrackerResultError`.
- The tracker only mirrors a held lock. Jira writes the `interlock.claim`
  property first, then assignee and `In Progress`, each read back. Restoration
  removes the property last, so a property that no longer names the claim means
  none of its writes remain. Otherwise it refuses assignee or status changes
  made outside Interlock and restores status, assignee, then the property.
  Verification accepts human changes but no remaining trace of the claim.
  Release restores the mirror before appending the release commit; a refused or
  failed mirror restoration keeps the lock held and requires recovery.
- A mirror conflict after the lock is held is reported as an ordinary failure so
  compensation releases the lock. Jira itself never advertises
  `conditional_update` or `atomic_assignment`.

[Lock tests](../test/git-claim-lock.test.ts) run against a real local bare
remote; [Jira tests](../test/jira.test.ts) cover the mirror and composition.

## Tracker guarantees

Restoration concerns owned fields and metadata, not the tracker's revision
counter or immutable history. A reread followed by an unconditional write is
not compare-and-swap. Neither an assignment API, timestamp, nor structured
claim property alone proves exclusive ownership.

Adapters must prove collision handling, verification, compensation, and
ambiguous-failure behavior before enabling live writes. Verification must cover
each restored field when assignment, metadata, and workflow status use separate
operations. Concurrent human changes must not be overwritten.

The CLI supplies the Git lock as the pickup claim authority. Its verified
capability requirements are `conditional_update`, `claim_identity`, and
`lease_metadata`; Jira need not advertise conditional writes, atomic assignment
or comments. Existing generic callers can still supply a tracker that provides
those guarantees itself.
[Tracker write policy](adr/0002-tracker-write-minimalism.md) keeps ownership in
structured storage and makes resolution comments optional. Capability checks
and tests must reflect an adapter's actual behavior.
