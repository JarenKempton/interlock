# ADR 0002: Tracker write minimalism

## Decision

Tracker tickets hold scope, acceptance criteria, status, assignment, dependencies,
and artifact links. Implementation detail and validation evidence belong in
the linked artifact. Do not rewrite descriptions or post summaries to narrate
work already documented elsewhere. Child tickets inherit map context.

Resolution requires the configured completion gates and an artifact link.
A comment is not an inherent resolution requirement. Prompts do not independently authorize closure or
tracker writes.

Claim ownership belongs in the
[Git-remote claim lock](../claim-semantics.md#git-remote-claim-lock), never in
comments; the tracker only mirrors it. Structured storage alone does not prove
atomic exclusion, so no tracker write decides ownership.

Amended for tracker port v2: an adapter declares a mirror tier. A `structured`
tracker mirrors claim and run in structured storage, and verification and
guarded restoration read that record back. An `assignee_only` tracker mirrors
only the owner and status, so it cannot tell two runs of one owner apart; for
it the Git ref is the only exact authority, and verification and restoration
read the ref for claim and run identity. Neither tier may claim without the
Git lock.

## Rationale

Duplicated narrative drifts and obscures the fields that coordinate work.
Separating ownership machinery from comments also keeps comment preferences
from weakening claim verification. Requiring structured storage would have
excluded trackers such as GitHub Issues whose only ownership field is the
assignee; the Git ref already holds the exact record, so the mirror need not.

This is a policy decision, not evidence that every adapter enforces it.
[Tracker implementations](../../src/adapters/trackers/) and their tests
determine supported behavior. Existing comments are history; this decision
does not authorize deleting them or invalidate in-flight ownership records.
