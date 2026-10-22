# Command harness adapters

[Profiles](../src/adapters/harnesses/profiles.ts) define launch arguments and
platform support. [The command adapter](../src/adapters/harnesses/command.ts)
renders argument arrays, performs preflight, and launches through the injected
platform. [Harness tests](../test/harness-adapters.test.ts) exercise those profiles.

Inspect `interlock adapter list` or `interlock adapter describe <name>` for
discovered capabilities. Finding an executable establishes availability only;
it cannot prove durable session identity, reconnect, status, or interruption.

Command adapters retain the exact child handle for same-process failure
compensation. They do not reconstruct ownership from a PID or infer a managed
session API from a vendor's interactive CLI features.

[T3](session-hosts/t3-adapter.md) uses structured host requests and scoped session
identity. It cannot be qualified by the generic command registry's executable
lookup. A session host may own its provider wiring; its configured provider
instance must not be replaced with a standalone harness name.
