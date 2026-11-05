# Domain vocabulary

[Domain types](../src/domain/model.ts), [reference validation](../src/domain/reference.ts),
and the contracts below define the portable contract. Adapters translate vendor objects into these terms.

## Glossary

| Term        | Meaning                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tracker     | The system of record for tickets (Jira, GitHub Issues, Linear, beads).                                                                                               |
| Namespace   | The tracker's dependency and policy boundary: a Jira project, GitHub owner/repository, or Linear team.                                                               |
| Map         | Tickets linked by blockers.                                                                                                                                          |
| Frontier    | The unclaimed tickets in a map whose blockers are all done.                                                                                                          |
| Claim       | Exclusive ownership of one ticket, held in a git ref in the claim home. The tracker only mirrors it.                                                                 |
| Claim home  | The git remote that holds the claim refs.                                                                                                                            |
| Project     | One repository plus where its work runs.                                                                                                                             |
| Machine     | A computer that work runs on, local or reached over the network (a laptop, SB1, a VPS).                                                                              |
| Isolation   | The boundary inside a machine where the agent executes (none, container, microVM).                                                                                   |
| Environment | Machine + isolation, the exact place a lane's processes run.                                                                                                         |
| Host        | Runs harness sessions and lets a person watch, steer or take over (the T3 Code server; tmux and headless are other hosts). T3 is always the host, never the harness. |
| Harness     | The agent program the host launches (Claude Code, Codex, Pi).                                                                                                        |
| Model       | The LLM a harness uses, with its options (for example, effort).                                                                                                      |
| Session     | One running harness conversation inside a host (a T3 thread).                                                                                                        |
| Workspace   | The checkout for one ticket inside the environment (a git worktree on task/KEY).                                                                                     |
| Lane        | Interlock's record that ties one ticket, claim, workspace, session and pull request together through their lifecycle.                                                |
| Gate        | A lane step that waits on an external fact (PR merged, review verdict on the head, tracker Done).                                                                    |
| Supervisor  | The long-running Interlock process, one per environment.                                                                                                             |
| Client      | Where a person or another program talks to Interlock (CLI, MCP, skills).                                                                                             |

“Agent” is informal prose for a harness session, never a configuration key or schema field.

## Placement

A project is placed in exactly one environment. Its lane's host, harness session,
workspace and supervisor all run in that environment. There is one supervisor
per environment, serving the projects placed there. A machine without isolation
is one environment, so it runs one supervisor. Each isolated environment on a
machine runs its own supervisor and host inside it; a containerised project's
processes all stay inside that container. Claims coordinate across machines
through the claim home, independently of supervisor lifetime.

The supervisor is the planned long-running `interlock run` process (JWB-951);
this vocabulary does not advertise an implemented command or remote placement.

## Identity

| Kind      | Form                                 | Meaning                                                   |
| --------- | ------------------------------------ | --------------------------------------------------------- |
| tracker   | `<adapter>:<instance>`               | One configured tracker installation                       |
| namespace | `<tracker-ref>:<namespace-id>`       | Tracker dependency and policy boundary                    |
| group     | `<namespace-ref>:group:<native-id>`  | Optional grouping of maps                                 |
| map       | `<namespace-ref>:map:<native-id>`    | Tracker anchor for linked tickets                         |
| ticket    | `<namespace-ref>:ticket:<native-id>` | One unit of work                                          |
| run       | `interlock-run:<id>`                 | Local execution identity                                  |
| claim     | `interlock-claim:<id>`               | Ownership held by the claim lock, mirrored by the tracker |

Qualification prevents collisions across tracker installations. A ticket
belongs to at most one map (its parent); its blockers can sit anywhere, and
dependency links are the only graph pickup reads. A ticket lists its blockers
as `dependencies` and the tickets it blocks as `dependents`.

A claim names a human owner and a run, and retains the original tracker snapshot.
A run never substitutes for its human assignee. See [claim semantics](claim-semantics.md).

## Capabilities

Each boundary owns its vocabulary: `TrackerCapabilities` and the claim lock's `conditional_update`, the only entry in `CAPABILITIES`.
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

## Lane

T3 Code hosts the session through its in-thread MCP tools; Interlock prepares
launch arguments but never launches or stops a harness session. Lane actions return a value or a
refusal with a machine-readable code. `lane attach --ticket REF`, run from the
worktree before any work, finds the ticket's one claimed run and its active
claim, verifies the current directory is that run's worktree root on its
recorded branch and that the remote claim lock is held by that claim, run and
owner, then binds the ticket's lane to them and starts it. Any mismatch
refuses and records no lane; repeating attach returns the same lane. The
[lane state machine](../src/domain/lane.ts) moves a lane
through queued, claimed, implementing, submitted, reviewing, approved
and done; legacy merged lanes remain completable; changes_requested loops back to implementing up to the lane's
configured round limit, then routes to attention, which resumes to the prior
state. Verdicts and evidence are bound to the submitted head and go stale for
any other head. `lane next` returns exactly one action for the lane's state.
Lanes persist in the local ledger, with or without a ticket; a one-off lane
can be promoted to a ticket. `lane complete --ticket KEY` accepts approved or
legacy merged lanes. GitHub must prove the recorded PR URL, branch and approved
head; a missing URL is adopted from the head branch. Before tracker mutation,
completion re-reads the remote claim's claim/run/owner identity. It journals the
intent, marks the ticket Done if needed and verifies the result by readback.
Retries recover unfinished intent and return the persisted success receipt.
Completion neither releases the claim nor removes the worktree or branch. Its result lists `unblocked`: the tickets
it blocks that pickup's eligibility check now accepts under the run's recorded
configuration. Computing the list only reads. A failed read reports the list
as unknown, never as empty, and completion still succeeds. Core owns the lane's one pull request:
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
deleted by completion. Later calls may adopt an existing PR but
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
[`LaneService`](../src/execution/lane.ts) expose the state machine as commands.

## Engine-ready contracts

These are domain types for a future durable-execution engine (such as Restate or
Temporal), not an implemented engine or supervisor. JWB-950 supplies the host
port and JWB-951 the supervisor. No existing action gains a capability by the
presence of these types.

- **Operation identity** ([type](../src/domain/operation/identity.ts)): a stable
  side-effect key, represented by the readonly pair `[lane, step]`. Its canonical
  string key is `JSON.stringify([lane, step])`, so delimiters in either component
  cannot collide. Replay uses the same lane and logical step, never a new run,
  timestamp or attempt ID. Distinct effects (including messages and review
  rounds) have distinct step names. A future engine records intent and result
  under that key and recovers an ambiguous effect before retrying; the key alone
  does not make an external write idempotent.
- **Gate evidence** ([type](../src/domain/gate/evidence.ts)): which fact satisfied
  a named gate, the source system and source reference read, when it was
  observed, and its observed value or ref. For example, a review gate names the
  approval fact from a PR's review system and the observed head SHA. Evidence
  for another head does not satisfy the current gate. Tracker evidence retains
  the ticket's qualified namespace reference; a host session's completion is
  not evidence that the PR merged or the tracker reached Done. Existing
  `LaneEvidence` is submission evidence, not a rename of this richer contract.
- **Host capability** ([type](../src/domain/host/capability.ts)): launch a harness
  session from a pickup plan, find sessions by lane or ticket, steer a session
  by sending a message, and recover after an ambiguous launch. The generic
  plan keeps vendor launch arguments outside the domain. Session identity
  includes its environment, host and harness; the environment's supervisor
  coordinates it. Launch and steer carry operation identity; recovery reuses
  the launch's identity and plan. Find returns all matches, and an empty search
  is not proof that launch failed. Recovery distinguishes a found session,
  proven non-launch and an unresolved outcome; only proven non-launch permits
  another launch attempt. Adapters must prove these semantics before advertising
  support.

## Conformance

[Tracker](../src/conformance/tracker.ts) and
[claim-lock](../src/conformance/claim-lock.ts) suites check collision,
stale-version refusal, readback, safe restoration, idempotence and ambiguous
writes. [Fakes](../test/conformance.test.ts), Jira and the Git lock run them.
