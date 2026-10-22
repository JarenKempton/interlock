# Interlock Adapter Protocol 1.0

External adapters are executables named `interlock-adapter-<name>`. They exchange one
JSON-RPC 2.0 object per line over stdin/stdout. Stdout is reserved for protocol
messages; structured diagnostics go to stderr.

## Initialization

Core sends `adapter.initialize` before any other method:

```json
{"jsonrpc":"2.0","id":"1","method":"adapter.initialize","params":{"protocol_version":"1.0","core_version":"0.1.0","adapter_kind":"tracker","workspace":"jira:example:ABC"}}
```

`adapter_kind` is one of `tracker`, `workspace`, `environment`, or `harness`.
Embedded and executable environment adapters expose the same lifecycle contract;
the protocol transport does not change ownership of application topology.
Environment profile references, plan summaries, warnings, and lifecycle evidence
are adapter-defined and opaque to core. Protocol 1.x does not define a universal
component catalog or local-versus-hosted service-routing schema.

The adapter responds with its identity and exact capabilities:

```json
{"jsonrpc":"2.0","id":"1","result":{"adapter":{"name":"example","version":"1.2.0","protocol_versions":["1.0"],"capabilities":["native_dependencies","conditional_update"]}}}
```

## Transport requirements

- Maximum message size: 1 MiB by default.
- One request ID maps to exactly one response.
- Unknown methods return JSON-RPC `-32601`.
- Incompatible major versions fail initialization.
- Calls are cancellable by terminating the adapter process.
- Secrets must not appear in argv, stdout, stderr, or error data.
- Credential-provider handles may be passed in scoped environment variables.
- Core applies per-call deadlines and treats process exit as an adapter failure.

## Conformance runner

`interlock adapter test <executable>` is a non-destructive initialization
smoke test for ordinary adapters. `interlock adapter conformance <fixture>` runs
the subprocess checks against a purpose-built fixture; it must not be
used against an ordinary adapter. The fixture selects its deliberate behavior from the scoped
`INTERLOCK_CONFORMANCE_SCENARIO` environment variable. The runner verifies 1.x
negotiation, the standard unknown-method error, deadline and explicit
cancellation termination, incremental response-size enforcement, crash
isolation, fresh-process recovery, and credential-provider handles passed only
through the environment. The client never places a credential handle or secret
in argv. Adapters inherit the caller environment so existing executable and
credential-provider discovery continues to work; callers can add or override
scoped variables explicitly.

This is a transport proof, not certification of tracker mutation semantics.
Each live adapter still needs its domain conformance suite before advertising
mutation capabilities.

The canonical JSON Schemas live under [`schemas/`](../schemas/).

## Markdown reference tracker

The bundled Markdown adapter is the credential-free reference implementation for tracker
conformance. Its fenced, line-anchored `interlock-tracker` JSON state block is the authoritative
hand-editable state. A tagged rendered index is generated from that state; prose outside both
tagged regions is preserved. Guarded mutations validate the complete document, use a monotonically
increasing version and adjacent exclusive lock, then validate again before atomic replacement.

Lock recovery is explicit: inspection reports absent, live, orphaned, or unknown ownership. Only a
same-host owner proven absent may be reclaimed, using the observed lock token; live, remote, and
malformed owners are never stolen. This reference adapter is not marked available in the registry
until a CLI construction and path-configuration boundary exists.

Every stored workspace, group, map, ticket, and dependency reference is fully qualified as
`markdown:<instance>:<workspace>...`; mixed adapters and cross-workspace edges are rejected. Reclaim
keeps the superseded claim record, including its `supersededBy` link, in per-ticket audit history
while the new active claim points back with `supersedes`.

Persistence writes and syncs a complete temporary file before asking Node/libuv to replace the
destination, then syncs the parent directory where directory handles support it.
The adapter claims only the replacement
semantics supplied by Node/libuv and the host filesystem—not universal power-loss atomicity;
replacement failure leaves the prior destination intact and removes the temporary file.

The [protocol client](../src/adapters/protocol.ts),
[transport conformance](../test/protocol.test.ts), and
[Markdown tracker tests](../test/markdown-tracker.test.ts) define executable checks.
