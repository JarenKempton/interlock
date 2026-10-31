# JWB-328: Docker Sandbox support across developer machines

Research date: 2026-08-22

## Question

What Docker Sandbox capabilities can Wayfinder safely rely on across supported
developer hosts, and what must `doctor` detect before advertising strong
isolation? Specifically: host prerequisites and virtualization; sandbox-private
clone behavior versus host-repo visibility; credential/secret boundaries;
network allow/deny policy; host port publication; CPU/memory controls and
overhead; and resume/stop/destroy semantics and failure modes. The acceptance
bar is a supported host/runtime matrix with explicit unsupported cases, the set
of capability probes `doctor` must run, a safe failure rule that performs **no
silent downgrade when isolation is required**, and implementation guidance for
the isolated-lane prototype.

## Result

Wayfinder should target the **standalone `sbx` CLI**, not the Docker
Desktop–integrated `docker sandbox` command. The integrated command is
deprecated; the standalone CLI needs neither Docker Desktop nor Docker Engine
and delivers uniform microVM isolation on macOS, Windows, and Linux through each
OS's native hypervisor. [Install Docker Sandboxes](https://docs.docker.com/ai/sandboxes/install/) · [Why microVMs: the architecture behind Docker Sandboxes](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/)

The isolation Wayfinder can rely on is real but conditional:

- **Isolation strength is a microVM hardware boundary**, not a container
  namespace. Each sandbox is a dedicated microVM with its own kernel and its own
  VM-isolated Docker daemon — no socket mounting, no host privileges, "no path
  back to the host." This is the capability worth advertising. [Why microVMs](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/)
- **The default workspace mode is NOT isolated from the host tree.** Direct mode
  (the default) bind-mounts the working tree read-write, so the agent's edits
  land on the host immediately. Host-private workspace isolation requires opt-in
  `--clone`, which mounts the host repo read-only at `/run/sandbox/source`. Any
  "strong isolation" claim that ignores this is wrong. [Usage](https://docs.docker.com/ai/sandboxes/usage/)
- **`--clone` is rejected from inside a linked git worktree** — it must run from
  the main working tree. Because Wayfinder lanes *are* worktrees, this is a
  direct, blocking constraint on the isolated-lane prototype, not a footnote. [Usage](https://docs.docker.com/ai/sandboxes/usage/)
- **Network isolation is HTTP/HTTPS-centric and deny-by-default.** All egress
  exits through a host filtering proxy at `host.docker.internal:3128`; HTTP/HTTPS
  is policy-filtered, raw TCP is allowable per IP:port rule, and UDP/ICMP are
  blocked at the network layer and cannot be re-enabled by policy. [Network policies](https://docs.docker.com/ai/sandboxes/network-policies/) · [Default security posture](https://docs.docker.com/ai/sandboxes/security/defaults/)
- **Host port publication ships** (`sbx ports --publish` / `sbx run --publish`),
  bound to loopback by default — dev servers are reachable. [Usage](https://docs.docker.com/ai/sandboxes/usage/)
- **No CPU/memory resource-limit flags are documented.** The dashboard exposes
  live CPU/memory *monitoring* only. Wayfinder cannot currently promise
  conservative resource admission through sandbox-native limits. [Usage](https://docs.docker.com/ai/sandboxes/usage/)

Bottom line for `doctor`: presence of `sbx` on PATH proves nothing about
isolation. `doctor` must probe login state, the native hypervisor, host OS
qualification, and the intended workspace mode, and it must **fail closed** when
a lane requests isolation that the host cannot satisfy.

## Supported host / runtime matrix

Legend: **supported** = explicitly listed as a system requirement by the primary
install docs; **qualified** = works but with a stated caveat; **unsupported** =
explicitly excluded or unlisted by the primary source.

| Host | Runtime status | Hardware / OS floor | Hypervisor probe | Notes |
|---|---|---|---|---|
| macOS | supported | macOS Sonoma 14+, Apple silicon | Apple's Hypervisor.framework | Intel Macs are not listed; Apple silicon only |
| Windows | supported | Windows 11, 64-bit Intel/AMD | Windows Hypervisor Platform (WHP) | WHP must be enabled as an optional feature |
| Linux (Ubuntu) | supported | Ubuntu 24.04+, 64-bit Intel/AMD or Arm | Linux KVM | User must be in the `kvm` group; KVM enabled |
| Linux (other distros) | qualified | — | Linux KVM | Artifact availability ≠ tested/supported; only Ubuntu is tested |
| VM / VDI host | qualified | — | nested virtualization | Requires nested virtualization support or the microVM cannot start |
| macOS Intel | unsupported | — | — | Not listed in system requirements |
| Windows 10 / older | unsupported | — | — | Windows 11 is the floor |
| Docker Desktop `docker sandbox` | deprecated | — | — | Superseded by standalone `sbx`; do not target |

Sources for the matrix: [Install Docker Sandboxes](https://docs.docker.com/ai/sandboxes/install/) · [Why microVMs](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/)

## Capability findings by area

### 1. Host prerequisites and virtualization

The standalone `sbx` CLI is the current, non-deprecated surface and requires
neither Docker Desktop nor Docker Engine: "You don't need Docker Desktop or
Docker Engine to use `sbx`." System requirements are macOS Sonoma 14+ on Apple
silicon; Windows 11 (64-bit) with the Windows Hypervisor Platform optional
feature enabled; and Ubuntu 24.04+ (64-bit Intel/AMD or Arm) with KVM enabled
and the user in the `kvm` group. Installation is via `brew install docker/tap/sbx`,
`winget install Docker.sbx`, or the Linux script/package, and **`sbx login`
(OAuth) is required before use**. Docker explicitly warns that a Linux artifact
existing for a distribution "does not indicate that Docker tests or supports the
corresponding distribution" — only Ubuntu is tested. VMs/VDI must support nested
virtualization. [Install Docker Sandboxes](https://docs.docker.com/ai/sandboxes/install/)

Architecturally, each sandbox is "a dedicated microVM with a private Docker
daemon isolated by the VM boundary, and no path back to the host," and "each
sandbox gets its own kernel." Docker built a custom cross-platform VMM rather
than adopting Firecracker (which "has no native support for macOS or Windows"),
running natively on "Apple's Hypervisor.framework, Windows Hypervisor Platform,
and Linux KVM." This is why isolation and startup guarantees are described as
identical across the three platforms. [Why microVMs](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/)

**Wayfinder implication:** the isolation Wayfinder can advertise is a hardware
VM boundary, uniform across supported OSes — but only after `doctor` confirms
the native hypervisor is present/enabled and the host OS meets the floor.

### 2. Sandbox-private clone vs. host-repo visibility

Two workspace modes exist, and the default is the weaker one for isolation:

- **Direct mode (default):** the working tree is bind-mounted read-write; agent
  changes appear on the host immediately. Good for iteration, but the host tree
  is mutable by the sandboxed agent.
- **Clone mode (`--clone`):** the sandbox works on a private in-sandbox clone;
  the host repository is mounted **read-only** at `/run/sandbox/source`. Changes
  stay inside the sandbox until fetched/pushed. The mode is fixed at create time,
  requires a git repository, and **is rejected when invoked from inside a
  non-main git worktree**. Removing the sandbox drops the clone.

[Usage](https://docs.docker.com/ai/sandboxes/usage/)

**Wayfinder implication:** "strong isolation" for a lane means clone mode. But
Wayfinder lanes run in linked worktrees, and `--clone` refuses to start from a
linked worktree, so the isolated-lane prototype must create sandboxes from the
main working tree (or a full clone), not from the per-lane worktree. `doctor`
and the lane launcher must treat "isolation required + running in a worktree" as
a hard incompatibility to resolve, never a silent fall-through to direct mode.

### 3. Credential / secret boundaries

Because the only egress path is the host filtering proxy, credential exposure is
bounded by what that proxy allows: outbound requests are policy-checked on the
host before leaving, and the microVM boundary — not the network policy — is the
"primary isolation." Network policy is explicitly "one layer of security, not
the only layer." A caveat matters for secret exfiltration: HTTPS proxying is
vulnerable to domain fronting, so an allowed domain can be abused to tunnel data
— "only allow domains you trust with your data." [Network policies](https://docs.docker.com/ai/sandboxes/network-policies/) · [Local policy](https://docs.docker.com/ai/sandboxes/security/policy/)

**Wayfinder implication:** treat the allowlist as the secret boundary. A lane
that must not reach a credentialed host should have that host denied (deny beats
allow), and Wayfinder should not advertise "secrets can't leave" beyond
"HTTP/HTTPS egress is policy-gated and UDP/ICMP are blocked."

### 4. Network allow / deny policy

Egress leaves only through the host proxy at `host.docker.internal:3128`.
Protocol handling is asymmetric and must be modeled precisely:

- **HTTP/HTTPS:** policy-filtered per request; blocked host → request stopped;
  server IP also checked against BlockCIDR rules.
- **Raw TCP (e.g. SSH):** blocked by default but allowable with an explicit
  rule for the destination IP and port (`sbx policy allow network "10.1.2.3:22"`).
- **UDP and ICMP:** blocked at the network layer and **cannot** be unblocked by
  policy.

The default posture is deny-by-default for HTTP/HTTPS plus blocking of private
IP ranges, loopback, and link-local addresses. On first start (and after
`sbx policy reset`) the daemon prompts for a preset: **Open** (all allowed),
**Balanced** (default-deny with common dev sites allowed), or **Locked Down**
(all blocked unless allowed). Rules use `sbx policy allow` / `sbx policy deny`,
apply to all sandboxes by default, take effect immediately, and **deny always
takes precedence over allow**. Host matching supports exact domains,
`*.example.com` wildcards, optional `:port` suffixes, and `**` for all hosts.
[Network policies](https://docs.docker.com/ai/sandboxes/network-policies/) · [Default security posture](https://docs.docker.com/ai/sandboxes/security/defaults/) · [sbx policy allow network](https://docs.docker.com/reference/cli/sbx/policy/allow/network/)

**Wayfinder implication:** Wayfinder can advertise HTTP/HTTPS allow/deny and
raw-TCP allow, but must not claim general UDP control. The preset chosen on
first start is host-global state `doctor` should surface (a lane expecting
Locked Down on an Open host is a misconfiguration).

### 5. Host port publication

Publishing sandbox ports to the host is shipped: `sbx run --publish 8080:3000`
at create time, or `sbx ports <name> --publish` on a running sandbox, with
`--unpublish` to withdraw. The mapping format is
`[[HOST_IP:]HOST_PORT:]SANDBOX_PORT[/PROTOCOL]` and bindings default to loopback.
Re-attaching with `sbx run` ignores `--publish`; use `sbx ports` to change
published ports on an existing sandbox. [Usage](https://docs.docker.com/ai/sandboxes/usage/)

**Wayfinder implication:** dev-server lanes are viable; Wayfinder should manage
publication through `sbx ports` after create rather than assuming re-attach
honors the original `--publish`.

### 6. CPU / memory controls and overhead

No CPU or memory resource-limit flags are documented for `sbx`; the dashboard
provides live CPU/memory **monitoring** only. Overhead is inherent and
per-sandbox: each sandbox is a full microVM with its own kernel and its own
Docker daemon and image cache, which the architecture framing describes as
trading higher resource overhead for complete isolation. [Usage](https://docs.docker.com/ai/sandboxes/usage/) · [Why microVMs](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/)

**Wayfinder implication:** conservative resource admission cannot rely on
sandbox-native caps today. Admission control must live in Wayfinder (limit
concurrent sandboxes) and be honest that per-lane CPU/memory ceilings are not
enforceable through documented `sbx` flags — an evidence-boundary item below.

### 7. Resume / stop / destroy semantics and failure modes

The lifecycle verbs are: `sbx run` (create + attach), `sbx create` (create
without attach; `-d/--detached`), `sbx stop` (retains state; restart by
`sbx run --name`), `sbx rm` (removes containers, cleans up git worktrees,
deletes state; cannot be undone; `--force`, `--all`), `sbx exec`, `sbx ls`, and
`sbx prune` (removes stopped sandboxes; `--dry-run`; never removes a running
sandbox). There is no distinct "resume" verb — a stopped sandbox is restarted by
name via `sbx run`. [Usage](https://docs.docker.com/ai/sandboxes/usage/)

**Wayfinder implication:** model resume as stop→`run --name`. `sbx rm` is
destructive and also cleans up git worktrees, so Wayfinder's own worktree
bookkeeping must reconcile with sandbox teardown to avoid removing a worktree
out from under a lane. `prune` is safe against running sandboxes but will reap
stopped ones — pair it with `--dry-run` before any automated cleanup.

## Capability probes `doctor` must run

Presence on PATH is necessary but not sufficient. Before advertising strong
isolation, `doctor` should probe, in order, and record each as an explicit
capability bit:

1. **Binary + version:** `sbx` resolvable on PATH (this is availability only —
   mirror the JWB-278 rule that "the executable exists" is not a lifecycle
   claim).
2. **Login state:** authenticated session present; without `sbx login` no
   sandbox runs. Report `unauthenticated` rather than a generic failure.
3. **Host OS qualification:** OS + version + arch against the matrix above
   (macOS 14+/Apple silicon; Windows 11 + WHP; Ubuntu 24.04+ + KVM/`kvm` group).
   Emit `windows-whp`, `linux-kvm`, `macos-hvf` as distinct environments, not a
   single "supported" boolean — the JWB-278 two-stage intersection model.
4. **Hypervisor presence:** native hypervisor enabled (WHP feature on; `/dev/kvm`
   accessible and user in `kvm` group; Hypervisor.framework on macOS). On VM/VDI
   hosts, nested virtualization must be present.
5. **Workspace-mode feasibility:** whether the intended mode is achievable here —
   critically, whether the launch context is a **linked worktree**, which makes
   `--clone` impossible.
6. **Network preset:** the active preset (Open/Balanced/Locked Down) and whether
   it satisfies the lane's required posture.
7. **Port publication:** ability to publish to the requested host port/loopback.

Probes 2–5 are the gating set for an "isolation: strong" advertisement. Probes
6–7 qualify network and dev-server lanes.

## Safe failure and no-silent-downgrade rule

When a lane declares that isolation is required, `doctor` and the launcher must
**fail closed**:

- If login, hypervisor, or OS qualification fails → **refuse to launch**;
  surface the specific unmet probe. Do not fall back to a non-isolated harness.
- If isolation requires clone mode but the context is a linked worktree (or the
  path is not a git repo) → **refuse**; do not silently launch direct mode,
  because direct mode gives the agent read-write access to the host tree. This
  is the single most important no-silent-downgrade case for Wayfinder, since
  lanes run in worktrees.
- If the active network preset is weaker than the lane requires (e.g. lane wants
  Locked Down, host is Open) → **refuse or explicitly re-scope**, never proceed
  under the weaker preset without recording it.
- If per-lane CPU/memory ceilings are required → acknowledge they are **not
  enforceable** via documented `sbx` flags and gate on Wayfinder-side admission
  (concurrency cap) instead of pretending a limit was applied.

The governing principle from Docker's own guidance reinforces this: network
policy is "one layer, not the only layer," and the microVM boundary is the
primary isolation — so Wayfinder must never let a network allowlist stand in for
a missing VM boundary. [Network policies](https://docs.docker.com/ai/sandboxes/network-policies/)

## Implementation guidance for the isolated-lane prototype

- **Target `sbx`, gate on `doctor`.** Wire the seven probes above into `doctor`
  and make "isolation: strong" a computed intersection (adapter capability ∩
  host probe ∩ OS qualification), exactly as JWB-278 recommends for harness
  session capabilities.
- **Resolve the worktree/clone conflict first.** The prototype's core open
  question is: create the sandbox from the main working tree (allowing `--clone`)
  and reconcile it with per-lane branches, versus accept direct mode with an
  explicit non-isolated label. Do not ship a path that silently uses direct mode
  for an isolation-required lane.
- **Model lifecycle as run/stop/run-by-name/rm.** Treat `sbx rm` as destructive
  and coordinate it with Wayfinder's worktree cleanup, since `sbx rm` also cleans
  git worktrees.
- **Manage ports via `sbx ports`** after create, not by assuming re-attach
  honors `--publish`.
- **Set network posture explicitly per lane** with `sbx policy`, remembering
  deny-beats-allow and that only HTTP/HTTPS + explicit raw-TCP are controllable.
- **Do the resource-limit work in Wayfinder**, not in `sbx`.

## Evidence boundary

- All capability claims come from Docker's own documentation and first-party
  engineering blog. Where a fact came from a first-party blog rather than the
  reference docs (the per-OS hypervisor names, custom-VMM rationale), it is cited
  to that blog. [Why microVMs](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/)
- **Version-number provenance:** any "Docker Desktop 4.57+/4.60+" figures seen in
  the wild describe the **deprecated** Docker Desktop–integrated `docker sandbox`
  command, not the standalone `sbx` CLI this research targets — the install docs
  state Docker Desktop is not required. Those numbers are deliberately excluded
  from the matrix to avoid a false standalone-`sbx` requirement.
- **CPU/memory limits:** absence of documented resource-limit flags is a negative
  finding from the usage docs reviewed on the research date; it is possible
  undocumented flags or later releases add them. `doctor` should re-probe at
  runtime rather than trust this snapshot.
- **Network protocol nuance:** the HTTP/HTTPS-vs-raw-TCP-vs-UDP/ICMP distinction
  is taken from the network-policies and default-posture pages; the `sbx policy`
  reference pages back the rule syntax. The `sbx …` reference pages render as
  JavaScript shells to plain fetches, so their exact flag surfaces were
  triangulated via Docker's domain-scoped search summaries rather than a raw page
  capture.
- Product releases move quickly; this matrix is design evidence, not a permanent
  allowlist. The authoritative check must remain the runtime `doctor` probes.
