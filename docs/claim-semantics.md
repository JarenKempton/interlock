# Claim and recovery semantics

[Pickup](../src/execution/pickup.ts), the [Git claim lock](../src/adapters/claims/git-lock.ts),
and [claim types](../src/domain/model.ts) implement these transitions.
[Pickup tests](../test/pickup.test.ts) and [lock tests](../test/git-claim-lock.test.ts)
exercise failure paths.

## Identity and leases

Tracker assignment names the responsible human. A run identifies one execution;
a claim binds that run, ticket, and owner to an exact pre-claim snapshot.
Local state alone never establishes ownership.

| Claim state | Meaning |
| --- | --- |
| `active` | Held by the claim lock and mirrored by the tracker |
| `released` | Explicit, verified restoration of the pre-claim fields |

Each claim records a lease expiry. Nothing renews it, and expiry never
authorizes release, reassignment, or a takeover: the claim stays held until it
is released explicitly.

## Release and recovery

Release explicitly returns ownership by conditionally restoring and verifying
the original claim-related fields. The ticket can be picked up again only if
the restored state is eligible. Closing a lane, stopping an agent, and deleting
a workspace are separate from release.

A run whose side effects could not be verified stays `recovery_required` with
its evidence in the ledger; `interlock runs export` shows it. A flag or human
assertion is not itself proof of the remote outcome.

## Pickup and compensation

Pickup persists each transition before beginning the next side effect. It
stops after workspace preparation and records the run as `claimed`, with T3
launch arguments in its plan; the T3 caller launches the lane. Preflights are read-only; the local recovery
intent (including the original snapshot) is journaled before the first remote
claim write. No workspace or agent side effect precedes the verified lock and
Jira mirror. Verified compensation marks the run `compensated` and its local
claim `released`; an uncertain outcome retains recovery evidence.

| From | Operation | Verified result | Failure path |
| --- | --- | --- | --- |
| `planning` | Complete preflights; capture snapshot | `claiming` | No tracker mutation |
| `claiming` | Conditional claim and readback | `claimed` | Definite collision ends `collision`; ambiguous result enters compensation |
| `claimed` | Prepare workspace | `workspace_prepared` | Compensation |
| `workspace_prepared` | Persist the `claimed` run | `prepared` | Compensation |

Compensation persists `compensating`, then attempts guarded restoration and
readback of the original tracker snapshot. Only verified restoration permits
`compensated`; uncertain restoration or persistence produces
`recovery_required`. Compensation never deletes the prepared workspace.

## Git-remote claim lock

Trackers without a conditional write, such as Jira Cloud, claim through an
append-only lock ref in a Git repository called the claim home:
[`GitClaimLock`](../src/adapters/claims/git-lock.ts), composed with the tracker
by [`ClaimCoordinator`](../src/execution/claims.ts): ownership writes go to the
lock, and the [tracker](domain-model.md#tracker) only mirrors them.

- The [claim home](../src/execution/claim-home.ts) is the first found of:
  `claim_home` in `interlock.toml` on the work repo's default branch (found
  with `git ls-remote --symref origin HEAD`, fetched, and its commit recorded),
  the user-level `claim-home` setting (`interlock config edit --set claim-home
  VALUE`), then the work repo's `origin`. A failed fetch or unreadable file
  stops pickup; only a confirmed missing file or key moves on. Pickup prints
  the home, its source and how to change it. The first verified claim saves
  the home it used as `claim-home` when none is set; a dry run never does.
- A home is stored as a normalized remote identity: any Git URL, or
  `owner/repo` as GitHub shorthand. URLs carrying credentials are refused.
- The lock runs in the work repo's Git directory and addresses the home by
  URL, never by remote name. Every operation checks that `insteadOf` and
  `pushInsteadOf` rules do not redirect it. A rejected push names the home;
  there is no fallback home or namespace.
- The ref is `refs/interlock/v2/<tracker instance>/<KEY>`, validated by
  `git check-ref-format`. Before the first remote write, pickup journals the
  home, record version, exact ref and config commit; the claim keeps them.
  Release and recovery use those saved values, never the current config.
- Claim and release each append one commit whose message holds
  the claim record, built on the observed tip and sent with an ordinary
  fast-forward push. The remote applies it only while the ref is still at that
  tip, and claim creates the ref only while it is absent. A losing writer gets
  `ClaimCollisionError`. Forced pushes, hook bypasses and ref deletion are never used.
- The lock version is the tip commit, or `absent`. It is the snapshot version
  that claim and release must match.
- A push that fails without a definite rejection is resolved with
  `git ls-remote` and the tip's record: our commit means it landed; a different
  tip means a collision; an unchanged tip or an unreadable remote remains
  `AmbiguousTrackerResultError`.
- An uncertain push retains its candidate commit and previous tip. Further
  reads through that lock cannot treat an absent or unchanged tip as proof of
  restoration: an accepted receive may still complete. Compensation leaves
  `recovery_required`, with the candidate and original snapshot in the run's
  export, until readback proves the write landed or a competing tip fenced it.
  Restarting the CLI does not resolve that recovery evidence or authorize a
  manual lock deletion.
- Lock commits and the Jira `interlock.claim` property both carry the home and
  record version (2). Readers check the version first: a newer record is
  refused and left untouched, and an older one is not read. Jira compares the
  home and version on write, readback and restore.
- Pickup refuses when Jira shows an assignee or any `interlock.claim` property
  (naming the property's home), or when the lock in the resolved home is held.
- The tracker only mirrors a held lock. Jira writes the `interlock.claim`
  property first, then assignee and `In Progress`, each read back. Restoration
  removes the property last, so a property that no longer names the claim means
  none of its writes remain. Otherwise it refuses assignee or status changes
  made outside Interlock and restores status, assignee, then the property.
  Verification accepts human changes but no remaining trace of the claim.
  Release restores and verifies the mirror before appending the release commit;
  a refused or failed mirror restoration keeps the lock held and requires recovery.
- A Jira write with a lost response, HTTP 202 or a server error can still be
  pending. The adapter retains its intended field value and refuses restoration
  until readback observes that value. The lock stays held while the outcome is
  unknown. Pickup and release persist the pending write in recovery evidence;
  a restarted release verifies it before sending another write. Definite
  request rejections permit compensation, while acknowledged completed writes
  still require the normal per-field verification.
- Before dispatching a Jira mutation, pickup and release commit its intent to
  the local transaction journal. Only a completed response, definite rejection
  or positive readback closes that journal entry. A process exit leaves an
  unfinished entry even without an error receipt. Release verifies it before
  continuing; competing journal writers and stale completions are rejected
  transactionally. An interrupted older release without this journal requires
  explicit recovery instead of an automatic retry.
- Pickup and release hold a separate SQLite process lock for the complete
  operation on the canonical local ledger, including restoration reads. A
  competing invocation fails before entering the operation. The operating
  system releases this exclusion on process exit; the durable Jira write
  journal still blocks retries whose remote outcome is unknown. Ledger reads
  remain available. The process lock is local exclusion, not remote ownership;
  moving or copying an active ledger cannot transfer a running operation.
- A mirror conflict after the lock is held is reported as an ordinary failure so
  compensation releases the lock. Jira itself never advertises
  `conditional_update`.
- Two races are known and accepted rather than blocked. Before a claim reaches
  Jira, two people resolving different homes can each hold a lock; Jira's
  unconditional property write decides, and the loser compensates only if its
  readback sees the other claim. After an interrupted release, Jira can be
  restored while the lock is still held, so someone using another home can
  claim the ticket; the first claim stays held until it is released. An
  expired lease never allows a takeover.
- Cutover from v1 is clean: v1 refs (`refs/interlock/claims/<KEY>`) and
  version-less records are not read, and release refuses claims recorded
  without a home. Release in-flight v1 claims with the old binary before
  upgrading.

[Lock tests](../test/git-claim-lock.test.ts) and
[lock conformance](../test/claim-lock-conformance.test.ts) run against real
local bare remotes; [Jira tests](../test/jira.test.ts) cover the mirror,
composition and tracker conformance.

## Tracker guarantees

Restoration concerns owned fields and metadata, not the tracker's revision
counter or immutable history. A reread followed by an unconditional write is
not compare-and-swap. Neither an assignment API, timestamp, nor structured
claim property alone proves exclusive ownership.

Adapters must prove collision handling, verification, compensation, and
ambiguous-failure behavior before enabling live writes. Verification must cover
each restored field when assignment, metadata, and workflow status use separate
operations. Concurrent human changes must not be overwritten.

The CLI supplies the Git lock as the pickup claim authority and requires its
`conditional_update` capability; Jira need not advertise conditional writes.
[Tracker write policy](adr/0002-tracker-write-minimalism.md) keeps ownership in
structured storage and makes resolution comments optional. Capability checks
and tests must reflect an adapter's actual behavior.
