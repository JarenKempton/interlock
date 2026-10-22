# ADR 0003: Organization policy and configuration

## Decision

Distinguish overridable defaults from enforced requirements. A conflicting
explicit override must fail and identify the requirement and its source;
silently ignoring it misleads the operator about the configuration in use.
Project requirements and personal choices follow this distinction in the
[configuration schema](../../src/configuration/schema.ts) and resolver.

Organization-wide policy belongs to the tracker scope. A tracker adapter is
the distribution boundary for that policy; core must not depend on a portfolio
application, a second organization identity system, or a separate policy
repository. Organizations using multiple trackers govern each tracker scope.

An organization may supply defaults or enforce keys. Enforced organization
policy cannot be weakened by project, map, personal, or invocation settings.
A conflict between requirements is an error, not a last-writer-wins merge.
Without an organization-policy capability, there is no implied organization
enforcement; built-in safe defaults apply.

Resolve policy host-side and retain provenance with the execution. An isolated
agent should not need tracker credentials just to receive its effective policy.
Present enforced settings and their sources when configuring an execution.

## Rationale

Preferences can differ between contributors; enforced policy must not depend
on who runs a command. Serving policy through the tracker uses the authority
already associated with the work and preserves provider independence.

This decision does not add a tracker operation or capability. Published identifiers
live in [the domain model](../../src/domain/model.ts), and configuration behavior
lives in [configuration](../../src/configuration/). Do not infer organization
governance from project-local requirements or advertise it before implementation.
