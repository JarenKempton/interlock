# ADR 0002: Tracker write minimalism

## Decision

Tracker tickets hold scope, acceptance criteria, status, assignment, dependencies,
and artifact links. Implementation detail and validation evidence belong in
the linked artifact. Do not rewrite descriptions or post summaries to narrate
work already documented elsewhere. Child tickets inherit map context.

Resolution requires the configured completion gates and an artifact link.
A comment is not an inherent resolution requirement. Prompts do not independently authorize closure or
tracker writes.

Claim ownership belongs in structured storage, not comments. Verification and
guarded restoration must read that ownership record. An adapter without a safe
structured mechanism must reject claiming. Structured storage alone does not
prove atomic exclusion; conditional behavior still requires collision-tested
evidence. Where the tracker has no conditional write, the
[Git-remote claim lock](../claim-semantics.md#git-remote-claim-lock) decides
ownership and the tracker's structured storage mirrors it.

## Rationale

Duplicated narrative drifts and obscures the fields that coordinate work.
Separating ownership machinery from comments also keeps comment preferences
from weakening claim verification.

This is a policy decision, not evidence that every adapter enforces it.
[Tracker implementations](../../src/adapters/trackers/) and their tests
determine supported behavior. Existing comments are history; this decision
does not authorize deleting them or invalidate in-flight ownership records.
