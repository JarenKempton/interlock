# Client and core ownership

Interlock's CLI owns portable execution: normalized tracker reads, eligibility
checks, claims, workspace preparation, configuration, launch arguments, and
recovery.
Adapters own vendor mechanics. The Git-remote claim lock decides ownership and
the tracker mirrors it; tracker facts remain durable coordination truth, and the
local ledger holds execution and recovery evidence.

T3 Code owns the lane: its conversation, agent provider, model, and the
in-thread MCP launch of the agent. A lane works one ticket in one worktree and
produces one pull request. Closing a lane does not release its claim.

Skills, MCP integrations, and other clients own presentation, map authoring,
role guidance, and translating a user's intent into an explicit operation.
Product Pipeline and other portfolio systems stay outside the execution core.
Clients must not infer success from a conversation or a progress message.

## Integration boundary

External clients invoke available public commands and request `--json` for
machine results. They must not import internal TypeScript modules, inspect the
SQLite database, call adapters directly, or parse human-formatted output.
Use generated `--help --json` to discover available actions and input contracts.
Output shapes belong to each action's definition.

### Pickup handoff

The in-thread T3 caller queries `orchestrator_capabilities` immediately before
pickup, including searches for configured models omitted from the short catalog.
It supplies the returned catalog as `{ "host": "t3", "observedAt": "<UTC ISO time>",
"catalog": <tool structured result> }` through `--t3-catalog PATH` or stdin with
`--t3-catalog -`. This is a trusted caller boundary: the CLI checks the supplied
catalog and its age (at most 60 seconds), not an independently authenticated T3
connection. Missing, stale, future-dated, disabled or ambiguous selections fail
before claiming. The caller must query again after a failure or delay.
The catalog age is checked again synchronously at claim-push dispatch, after
remote reads and local commit preparation. An expired catalog prevents that
push; this does not guarantee availability during the subsequent network call.

`pickup KEY --dry-run --json --t3-catalog PATH` reads configuration and Jira and
returns a plan without creating a ledger, workspace or claim. The work repo is
the current directory or `--repo PATH`; worktrees go under
`<repo parent>/worktrees/<repo name>/KEY` and branch from the origin's default
branch. A mutating pickup verifies the Git lock and Jira mirror, prepares the
branch from `--branch NAME` or the `branch` template, and records a `claimed`
run with that branch; later lane commands use the recorded name. Its JSON `launch` object is
the argument object for `t3_thread_launch`, including `existing_worktree`, title,
message and model selection. The caller invokes that tool and retains its
returned thread identity; pickup does not launch an agent or claim it did.

Pickup checks eligibility (open, unassigned, in a pickable status, every blocker
closed) before claiming and again before writing the mirror. A parent epic is
not required. Unfinished or unreadable blockers
fail closed. Jira search supplies ordering; a subsequent direct issue read
supplies current fields, so search index lag cannot reopen completed tickets or
hide reopened blockers.

The implementer uses the user's `agent` and `model`, or the calling thread's
when unset, checked against exact provider instance/model IDs and advertised
option values. Inherited T3 model options apply only to the same provider
instance and model; `effort` and `context_window` override them. The plan's
`reviewers` object has one checked selection per lens in the user's
`reviewers` setting, using the implementer's selection unless `reviewer_agent`,
`reviewer_model` or `reviewer_effort` is set; with no lenses it is empty.
Pickup starts no reviewer.

The launch message carries the lane procedure, with the exact Interlock
invocation and ledger pickup used: `lane attach` before any work, commits on
the branch only, `lane submit` to push and open the one pull request, then
`link_pull_request` and `watch_pull_request` on that URL and no other. Each
planned lens runs as a `delegate_task` review inside the lane with its plan
target; the lane records one verdict for the submitted head, and merge stays
outside the lane. After the merge, `lane merge` and `lane complete` verify it
and retire the worktree and branch. Interlock enforces the attach checks, the
one-pull-request rule, head binding and merge readback. It cannot enforce what
the agent does outside its commands: the procedure tells the agent not to use
GitHub write credentials, and only the host can withhold them.

`interlock login jira` verifies an email and API token against Jira's `/myself`
and keeps them in the OS credential store (macOS Keychain, Windows Credential
Manager, or Linux Secret Service, through Bun's built-in `Bun.secrets`); the site it asks for is
saved in user settings. `JIRA_USER_EMAIL` and `JIRA_API_TOKEN` override the store
for CI and headless agents, and `JIRA_SITE` overrides the saved site. Each tracker
adapter declares its credential fields, verification call and permission check
(`TrackerSignIn` in `src/domain/tracker.ts`); the core prompts, stores and looks
them up. `interlock doctor` reports sign-in, missing Jira permissions and Git
claim-lock push access. Pickup's site comes from shared configuration, else
user settings; an optional `JIRA_SITE` must match it. The authenticated Jira account owns the claim.
Instruction paths resolve relative to the shared TOML. The Jira Rank
field is discovered through a read-only endpoint; a claimed status with no
Jira transition fails closed.

`claim release CLAIM --json` uses the saved execution configuration and verifies
the authenticated owner, remote lock and restored Jira fields. It preserves the
workspace, including dirty work. Release does not require the ticket's current
parent map, Rank discovery or the original workspace base branch.
A lost local release receipt can be retried;
an uncertain remote result remains `recovery_required`. `runs list`, `runs show`
and `runs export` expose local run evidence; export includes configuration,
claim, plan steps and recovery details. These commands accept `--state PATH`
when an explicit local ledger is needed. Closing a T3 thread is not release.
An uncertain Jira write's intended field value is retained in recovery evidence.
Release retries first verify that pending write completed; unchanged pre-write
state cannot establish restoration or authorize another write.
The write intent is committed before dispatch, so this guard also applies when
the process exits during the request without recording an error. The unfinished
intent remains visible in `runs export`.
Pickup and release exclude overlapping mutation operations using the same
canonical ledger. A competing invocation fails immediately and can be retried
after the active process exits; read-only run inspection remains available.
Keep an active ledger at its original path until its operations finish.

Pickup takes exactly one ticket key. Secrets
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
actions, with its workflow and permissions configured explicitly. Releasing
ownership never stops a lane or deletes a workspace.
