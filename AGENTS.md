# Agent instructions

## Project intent

Interlock is a tracker-to-agent dispatcher. It claims a ticket through the
Git-remote claim lock, which the tracker mirrors, prepares a Git worktree, and
hands the ticket to an agent in a T3 Code lane: one lane, one ticket, one pull
request. Preserve tracker, host, model, and workspace independence in all core
packages.

The implementation language is TypeScript. Vite+ (`vp`) is the toolchain entry
point: `vp env` manages the Node.js version pinned in `.node-version` for Vite+,
Oxlint, and Oxfmt. Bun is the pinned package manager and the runtime for the
application, tests, and compiled executable. Install with `vp install`; run tasks
with `vp run <name>`. `vp run test` runs `bun test`, never Node-based `vp test`.
Task definitions, lint rules, and formatting live in `vite.config.ts`.
Bun-specific behavior belongs in narrow platform modules; portable domain and
transaction logic should remain ordinary TypeScript.

## Non-negotiable behavior

- Tracker state is durable coordination truth; chat history is not.
- Ticket reads do not mutate anything.
- Claim before work and use conditional mutations where a tracker supports them.
- Do not advertise capabilities an adapter cannot verify.
- Never automatically release or reassign an expired claim.
- Never delete a workspace as a side effect of stopping a run.
- Never pass secrets in process arguments, logs, receipts, or ordinary config.
- Product Pipeline and other portfolio systems stay outside the execution core.

## Engineering rules

- Keep public protocol changes backward compatible within a protocol major.
- Use argument arrays with `Bun.spawn`; never compose shell commands.
- Add tests for every state-machine transition and failure compensation path.
- Run `vp check`, `vp run test`, and `vp run typecheck` before handoff.
- Follow the target tree and layer rules in [architecture](docs/architecture.md).
- Existing lint exemptions in `tooling/lint-baseline.json` may only shrink; never
  add files or rules. Split folders by concept before exceeding 12 handwritten
  files. Generated migrations are exempt.
- Do not add a live tracker mutation until fake-adapter tests prove collision,
  verification, compensation, and ambiguous-failure behavior.

## Documentation

- Keep repository docs to usage, maintained contracts, and concise decision rationale.
- Keep work status and acceptance criteria in the tracker; review findings and
  validation output belong with the change under review. Do not commit progress
  reports, handoffs, release queues, investigation transcripts, or machine-local
  acceptance packets, including on documentation branches.
- Link to schemas, action definitions, tests, and workflows instead of copying
  their inventories or output. Generated help is the command reference.
- Update the existing authoritative document when behavior changes. Delete
  superseded text; Git history preserves it. Do not add reconciliation documents.
