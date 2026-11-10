# Domain vocabulary

[Domain types](../src/domain/model.ts), [reference validation](../src/domain/reference.ts),
and the contracts below define the portable contract. Adapters translate vendor objects into these terms.

## Glossary

| Term        | Meaning                                                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tracker     | The system of record for tickets (Jira, GitHub Issues, Linear, beads).                                                                                                                          |
| Namespace   | The tracker's dependency and policy boundary: a Jira project, GitHub owner/repository, or Linear team.                                                                                          |
| Map         | Tickets linked by blockers.                                                                                                                                                                     |
| Frontier    | The unclaimed tickets in a map whose blockers are all done.                                                                                                                                     |
| Claim       | Exclusive ownership of one ticket, held in a git ref in the claim home. The tracker only mirrors it.                                                                                            |
| Claim home  | The git remote that holds the claim refs.                                                                                                                                                       |
| Project     | One repository plus where its work runs.                                                                                                                                                        |
| Machine     | A computer that work runs on, local or reached over the network (a laptop, SB1, a VPS).                                                                                                         |
| Isolation   | The boundary inside a machine where the agent executes (none, container, microVM).                                                                                                              |
| Environment | Machine + isolation, the exact place a lane's processes run.                                                                                                                                    |
| Host        | Runs harness sessions and lets a person watch, steer or take over (the T3 Code server; tmux and headless are other hosts). T3 is always the host, never the harness.                            |
| Harness     | The agent program the host launches (Claude Code, Codex, Pi).                                                                                                                                   |
| Model       | The LLM a harness uses, with its options (for example, effort).                                                                                                                                 |
| Session     | One running harness conversation inside a host (a T3 thread).                                                                                                                                   |
| Workspace   | The checkout for one ticket inside the environment (a git worktree on task/KEY). Interlock prepares it, or the host creates it on a host launch; Interlock verifies and records it before work. |
| Lane        | Interlock's record that ties one ticket, claim, workspace, session and pull request together through their lifecycle.                                                                           |
| Gate        | A lane step that waits on an external fact (PR merged, review verdict on the head, tracker Done).                                                                                               |
| Supervisor  | The long-running Interlock process, one per environment.                                                                                                                                        |
| Client      | Where a person or another program talks to Interlock (CLI, MCP, skills).                                                                                                                        |

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

T3 Code hosts the session. Pickup either returns launch arguments for the
caller's in-thread MCP tools, or, with `--launch`, launches the session itself
through the verified t3 CLI (see [host capability](#engine-ready-contracts)).
Interlock never stops a harness session. Lane actions return a value or a
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
After Done readback, `removeMirror` removes only the matching tracker claim
marker, with its own `removed_verified` receipt, then completion appends a v2
release record against the freshly read Git tip. Same-run, same-owner legacy
`interlock-claim:retirement-` records are also releasable; replacement ownership
is never released. The release preserves history and `leaseExpiresAt`.
Retries recover journaled writes and return the persisted success receipt.
The run and claim become terminal together with the done lane. Completion never
removes the worktree or branch. Re-picking a reopened ticket remains a known
limit because prior workspace and lane state are not reset automatically.
Its result lists `unblocked`: the tickets
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

Before each push, submit verifies the claimed run's workspace identity, the
active local ticket claim and a fresh remote claim/run/owner readback. It does
not reserve a PR create permit. A failed push can be retried without repairing
remote refs. PR lookup covers every state on the head branch and complete
ticket-key title matches: multiple candidates refuse `duplicate_artifact`,
and a closed or merged branch PR refuses `artifact_mismatch` instead of being
replaced. An ambiguous create returns `ambiguous_write` unless readback can
adopt its PR; the next submit looks up the branch again before creating.

GitHub search is eventually consistent, so this is not an exactly-once creation
guarantee. Existing `refs/interlock/submissions/v1/*` refs are unused and left
untouched. Claim-record v2 is unchanged. The
[submit tests](../test/lane-submit.test.ts) define retry and ownership behavior.
The lane agent needs no GitHub write credential for submission; removing
ambient credentials from the lane environment remains the host's job. The `lane` actions and
[`LaneService`](../src/execution/lane.ts) expose the state machine as commands.

## Engine-ready contracts

These domain types give side effects a stable identity so a journal today, or
a durable-execution engine later ([ADR 0003](adr/0003-supervisor-on-the-journal.md)),
can replay them. No action gains a capability by the presence of these types.

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
- **Host capability** ([type](../src/domain/host/capability.ts)): preflight the
  host, launch a harness session from a pickup plan, find sessions by lane or
  ticket, read one, steer it by sending a message, and recover after an
  ambiguous launch. The generic plan keeps vendor launch arguments outside the
  domain. Session identity includes its environment, host and harness; the
  environment's supervisor coordinates it. Launch and steer carry operation
  identity; recovery reuses the launch's identity and plan. Find returns all
  matches, and an empty search is not proof that launch failed. Recovery
  distinguishes a found session, proven non-launch and an unresolved outcome;
  only proven non-launch permits another launch attempt. An ambiguous launch
  records whether the host acknowledged it; recovery that finds nothing after an
  acknowledged launch stays unresolved. Adapters must prove these semantics
  before advertising support.

  The [T3 adapter](../src/adapters/hosts/t3/port.ts) implements it with
  `t3 thread start`, `list`, `show` and `send`; messages go on stdin, never in
  arguments. Preflight requires the t3 CLI to run, the server's
  `/.well-known/t3/environment` to report the same `major.minor.patch` and
  orchestration protocol 2, and `thread list` to resolve the repository's T3
  project. Launch passes the repository's main checkout as the project, so the
  T3 project that owns the repository is resolved by path from any caller. It
  binds `--worktree` to the exact fetched base commit, never a branch name,
  `--branch` to the lane branch and, when one is selected, `--provider`
  and `--model`. The CLI cannot bind model options or modes, so `--launch`
  refuses them. Configured reviewer lenses are not bound at launch: each lens
  target (`reviewer_harness`, `reviewer_model` and `reviewer_effort`, or the
  implementer's harness and model) goes into the lane procedure, T3 validates it
  when the lane delegates the review, and a rejected target routes the lane to
  attention instead of a substitute review. A launch counts only after
  `thread show` reads the thread back in the same project with the plan's title, selected harness and model, a
  healthy status, the lane branch and a worktree path. Exit 0 without a readable thread, a failed thread, or
  another branch is ambiguous. Recovery reads the project's threads by the
  plan's title; it proves non-launch only when no such thread and no lane
  branch exist, locally or on origin. Steer is not idempotent: an unconfirmed
  send is reported as ambiguous and never resent automatically.

  `pickup KEY --launch` runs host preflight and refuses an existing lane branch
  before claiming, then creates or reuses the ticket's queued lane, claims, and
  launches once under `[lane, "launch"]`. T3 creates the worktree; pickup
  records its path and branch on the run, and `lane attach` still verifies the
  worktree, branch and claim before work. A proven non-launch, or a host refusal
  raised before `thread start`, compensates the claim. An unresolved launch
  keeps the claim, marks the run `recovery_required` and is never retried for
  that claim. Once the host reports a session, any later pickup failure,
  including a ledger write, is unresolved rather than compensated. Neither deletes a
  thread, branch or worktree.

## Supervisor

`interlock run --project MAP=REPO[,MAP=REPO]` is the environment's one
supervisor ([tick](../src/execution/supervisor/tick.ts)). It acts only on
tickets its maps list, and with `--only KEY[,KEY]` only on those tickets: other
lanes in the ledger are never completed, resumed, steered or counted toward
`--parallelism`. A map's children must belong to the map's own tracker project.
When a map cannot be listed, the tick launches nothing. Each tick, in order:

1. **Completion.** For an approved or merged lane it reads GitHub merge state.
   When merged, it re-reads the ticket, its blockers and the remote claim ref,
   then runs `lane complete`, whose receipts cover the merge proof, the Done
   readback, the mirror removal and the claim release.
2. **Sessions.** For a claimed or implementing lane, or a launched lane that has
   not attached yet, it reads the host session recorded at launch, or the one
   thread titled with the ticket key when none was recorded. A session whose
   status and last message have not changed for `--stall-minutes` is resumed
   with a host message under `[lane, "resume:N"]`, journaled before it is sent,
   up to a resume allowance per stall window. A lane update, such as a person
   resuming it from attention, starts a new window. A session that is missing,
   duplicated or unreadable for three ticks in a row, a run that needs recovery,
   an unconfirmed resume, a pending resume found after a restart, or a stall
   past the allowance moves the lane to attention. Submitted and reviewing lanes
   are not resumed: they wait on checks and a person.
3. **Frontier.** It lists each map's tickets in rank order and launches each
   open, unassigned, pickable ticket whose blockers are closed, with no held
   claim and no lane in the ledger, through `pickup --launch`, until the number
   of unfinished lanes reaches `--parallelism`. A launched lane that has not
   attached yet counts.

Human edits win. A ticket reassigned away from the claim owner, moved out of
the claimed status, re-blocked, or whose remote claim is no longer the lane's,
is held and not advanced. A released claim record counts as no claim, unless
the lane's own interrupted completion wrote it. A lane whose claim cannot be
resolved needs attention. A ticket with only done lanes that is open again is
reported as reopened and not picked up. The supervisor never releases or
reassigns a claim. Completion refusals route the lane to attention unless they
are transient tracker, claim-lock, artifact-host or readback failures, which
retry on the next tick without marking the run for recovery.

Each observed fact is journaled as [gate evidence](../src/domain/gate/evidence.ts)
when its value changes. `interlock status` shows each lane's state, whether it
needs attention, and the latest evidence per gate. `interlock service install`
writes a systemd user unit that starts at boot, or a launchd agent that starts
at login, running the same command and restarting it on failure. A tick that
runs past 20 minutes exits the process so the service restarts it.

## Review policy

A pickup plan declares its `review` policy: `lenses` when reviewer lenses are
configured, otherwise the declared default `human`, where the agent moves the
lane to review and attention and a person records the verdict. `lane submit`
without `--gate` pushes and opens the pull request first; a second
`lane submit` with the gate and the evidence URL for that pushed head records
the evidence and submits the lane.

## Conformance

[Tracker](../src/conformance/tracker.ts) and
[claim-lock](../src/conformance/claim-lock.ts) suites check collision,
stale-version refusal, readback, safe restoration, idempotence and ambiguous
writes. [Fakes](../test/conformance.test.ts), Jira and the Git lock run them.
