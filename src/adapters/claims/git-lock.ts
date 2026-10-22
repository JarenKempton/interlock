import { z } from "zod";
import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
  type Clock,
  type ReclaimRequest,
  type ReleaseClaimRequest,
  type RenewLeaseRequest,
} from "../../domain/contracts.ts";
import {
  actorRefSchema,
  claimRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../../domain/identifiers.ts";
import { type ClaimRef, capabilities, type TicketRef } from "../../domain/model.ts";
import { parseRef } from "../../domain/reference.ts";
import {
  BunGitCommandExecutor,
  type CommandResult,
  type GitCommandExecutor,
} from "../workspaces/git.ts";

export const ABSENT_LOCK_VERSION = "absent";
export const CLAIM_LOCK_NAMESPACE = "refs/interlock/claims";

const lockRecordSchema = z.strictObject({
  action: z.enum(["claim", "renew", "release", "reclaim"]),
  ticket: ticketRefSchema,
  claim: claimRefSchema,
  run: runRefSchema,
  owner: actorRefSchema,
  leaseExpiresAt: z.string(),
  supersedes: claimRefSchema.optional(),
  authorizedBy: actorRefSchema.optional(),
});
export type ClaimLockRecord = z.infer<typeof lockRecordSchema>;

export interface ClaimLockState {
  version: string;
  record: ClaimLockRecord | null;
}

export interface GitClaimLockOptions {
  repository: string;
  remote: string;
  git?: GitCommandExecutor;
  clock?: Clock;
  beforeClaimWrite?: () => void;
}

export class GitClaimLock {
  readonly #repository: string;
  readonly #remote: string;
  readonly #git: GitCommandExecutor;
  readonly #clock: Clock;
  readonly #beforeClaimWrite: (() => void) | undefined;
  readonly #pendingWrites = new Map<TicketRef, { version: string; commit: string }>();
  #emptyTree?: string;

  constructor(options: GitClaimLockOptions) {
    if (!options.repository || !options.remote)
      throw new Error("Claim lock repository and remote are required");
    this.#repository = options.repository;
    this.#remote = options.remote;
    this.#git = options.git ?? new BunGitCommandExecutor();
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#beforeClaimWrite = options.beforeClaimWrite;
  }

  async describe() {
    return capabilities("conditional_update", "claim_identity", "lease_metadata");
  }

  async ref(ticket: TicketRef): Promise<string> {
    const key = parseRef(ticket).nativeId;
    const ref = `${CLAIM_LOCK_NAMESPACE}/${key}`;
    if (
      !key ||
      key.includes("/") ||
      (await this.#run(["git", "check-ref-format", ref])).exitCode !== 0
    )
      throw new Error(`Ticket key cannot name a claim lock ref: ${ticket}`);
    return ref;
  }

  async read(ticket: TicketRef): Promise<ClaimLockState> {
    const ref = await this.ref(ticket);
    const tip = await this.#remoteTip(ref);
    const pending = this.#pendingWrites.get(ticket);
    if (pending) {
      if (!tip || tip === pending.version) throw this.#unknownPush(ticket);
      this.#pendingWrites.delete(ticket);
    }
    if (!tip) return { version: ABSENT_LOCK_VERSION, record: null };
    const record = await this.#record(ref, tip);
    if (record.ticket !== ticket) throw new Error(`Claim lock ${ref} belongs to ${record.ticket}`);
    return { version: tip, record };
  }

  async claim(request: ClaimRequest): Promise<void> {
    this.#requireFutureLease(request.leaseExpiresAt);
    const state = await this.#expect(request.ticket, request.expectedVersion);
    if (heldClaim(state)) throw new ClaimCollisionError("Ticket claim lock is held");
    await this.#append(request.ticket, state, {
      action: "claim",
      ticket: request.ticket,
      claim: request.claim,
      run: request.run,
      owner: request.owner,
      leaseExpiresAt: request.leaseExpiresAt,
    });
  }

  async renew(request: RenewLeaseRequest): Promise<void> {
    this.#requireFutureLease(request.leaseExpiresAt);
    const state = await this.#expect(request.ticket, request.expectedVersion);
    const held = heldBy(state, request.claim);
    await this.#append(request.ticket, state, {
      action: "renew",
      ticket: held.ticket,
      claim: held.claim,
      run: held.run,
      owner: held.owner,
      leaseExpiresAt: request.leaseExpiresAt,
      ...(held.supersedes ? { supersedes: held.supersedes } : {}),
    });
  }

  async releasable(request: ReleaseClaimRequest): Promise<ClaimLockState> {
    const state = await this.#expect(request.ticket, request.expectedVersion);
    if (heldBy(state, request.claim).owner !== request.authorizedBy)
      throw new ClaimCollisionError("Claim lock owner does not match the release authority");
    return state;
  }

  async release(request: ReleaseClaimRequest): Promise<void> {
    const state = await this.releasable(request);
    await this.#append(request.ticket, state, releaseRecord(state, request.authorizedBy));
  }

  async restore(ticket: TicketRef, claim: ClaimRef): Promise<void> {
    const state = await this.read(ticket);
    if (heldClaim(state)?.claim !== claim) return;
    await this.#append(ticket, state, releaseRecord(state));
  }

  async reclaim(request: ReclaimRequest): Promise<void> {
    this.#requireFutureLease(request.leaseExpiresAt);
    const state = await this.#expect(request.ticket, request.expectedVersion);
    const stale = heldBy(state, request.staleClaim);
    if (Date.parse(stale.leaseExpiresAt) > this.#clock.now().getTime())
      throw new ClaimCollisionError("Claim lock lease is not stale");
    await this.#append(request.ticket, state, {
      action: "reclaim",
      ticket: request.ticket,
      claim: request.claim,
      run: request.run,
      owner: request.owner,
      leaseExpiresAt: request.leaseExpiresAt,
      supersedes: request.staleClaim,
      authorizedBy: request.authorizedBy,
    });
  }

  async #expect(ticket: TicketRef, expectedVersion: string): Promise<ClaimLockState> {
    const state = await this.read(ticket);
    if (state.version !== expectedVersion)
      throw new ClaimCollisionError("Claim lock changed since it was read");
    return state;
  }

  async #append(ticket: TicketRef, state: ClaimLockState, record: ClaimLockRecord): Promise<void> {
    await this.#verifyRemote();
    const ref = await this.ref(ticket);
    const parent = state.version === ABSENT_LOCK_VERSION ? [] : ["-p", state.version];
    const commit = await this.#checked([
      "git",
      "-c",
      `user.name=${record.owner}`,
      "-c",
      "user.email=interlock@invalid",
      "commit-tree",
      await this.#tree(),
      ...parent,
      "-m",
      `interlock ${record.action} ${ref}`,
      "-m",
      JSON.stringify(lockRecordSchema.parse(record)),
    ]);
    if (record.action === "claim") this.#beforeClaimWrite?.();
    this.#pendingWrites.set(ticket, { version: state.version, commit });
    let push: CommandResult | undefined;
    try {
      push = await this.#run(["git", "push", "--porcelain", this.#remote, `${commit}:${ref}`]);
    } catch {
      push = undefined;
    }
    let tip: string | null;
    try {
      tip = await this.#remoteTip(ref);
    } catch {
      throw this.#unknownPush(ticket);
    }
    if (tip === commit) {
      this.#pendingWrites.delete(ticket);
      return;
    }
    if (tip && tip !== state.version) {
      this.#pendingWrites.delete(ticket);
      throw new ClaimCollisionError("Claim lock was written concurrently");
    }
    const rejected = !push || push.exitCode === 0 ? undefined : /^!\t.*$/m.exec(push.stdout)?.[0];
    if (rejected) {
      this.#pendingWrites.delete(ticket);
      throw new Error(`Claim lock push was rejected: ${rejected.trim()}`);
    }
    throw this.#unknownPush(ticket);
  }

  #unknownPush(ticket: TicketRef): AmbiguousTrackerResultError {
    const pending = this.#pendingWrites.get(ticket);
    return new AmbiguousTrackerResultError(
      `Claim lock push outcome is unknown: ${pending?.commit} from ${pending?.version}; unchanged readback cannot rule out a pending write`,
    );
  }

  async #remoteTip(ref: string): Promise<string | null> {
    await this.#verifyRemote();
    const output = await this.#checked(["git", "ls-remote", this.#remote, ref]);
    const line = output
      .split(/\r?\n/)
      .map((item) => item.split("\t"))
      .find((item) => item[1] === ref);
    return line?.[0] || null;
  }

  async #verifyRemote(): Promise<void> {
    const fetch = await this.#run(["git", "remote", "get-url", "--all", this.#remote]);
    if (fetch.exitCode !== 0) {
      const name = this.#remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const configured = await this.#run([
        "git",
        "config",
        "--get-regexp",
        `^remote\\.${name}\\.(url|pushurl)$`,
      ]);
      if (configured.exitCode !== 1)
        throw new Error("Claim lock fetch destination cannot be verified");
      await this.#verifyLiteralRemote();
      return;
    }
    const fetchUrls = fetch.stdout.trim().split(/\r?\n/);
    const pushUrls = (
      await this.#checked(["git", "remote", "get-url", "--push", "--all", this.#remote])
    ).split(/\r?\n/);
    if (
      fetchUrls.length !== 1 ||
      !fetchUrls[0] ||
      pushUrls.length !== 1 ||
      fetchUrls[0] !== pushUrls[0]
    )
      throw new Error("Claim lock requires one identical fetch and push destination");
  }

  async #verifyLiteralRemote(): Promise<void> {
    const expanded = await this.#checked(["git", "ls-remote", "--get-url", this.#remote]);
    const rewrites = await this.#run([
      "git",
      "config",
      "--null",
      "--get-regexp",
      "^url\\..*\\.pushinsteadof$",
    ]);
    if (rewrites.exitCode === 1) return;
    if (rewrites.exitCode !== 0) throw new Error("Claim lock push rewrites cannot be verified");
    for (const entry of rewrites.stdout.split("\0").filter(Boolean)) {
      const separator = entry.indexOf("\n");
      if (separator < 0) throw new Error("Claim lock push rewrites cannot be verified");
      const prefix = entry.slice(separator + 1);
      if (this.#remote.startsWith(prefix) || expanded.startsWith(prefix))
        throw new Error(
          "Claim lock literal remote has push rewriting; use a verified named remote",
        );
    }
  }

  async #record(ref: string, tip: string): Promise<ClaimLockRecord> {
    if ((await this.#run(["git", "cat-file", "-e", `${tip}^{commit}`])).exitCode !== 0)
      await this.#checked(["git", "fetch", "--no-tags", this.#remote, ref]);
    const commit = await this.#checked(["git", "cat-file", "commit", tip]);
    const message = commit.slice(commit.indexOf("\n\n") + 2);
    try {
      return lockRecordSchema.parse(JSON.parse(message.slice(message.indexOf("\n\n") + 2)));
    } catch {
      throw new Error(`Invalid claim lock record at ${ref} ${tip}`);
    }
  }

  async #tree(): Promise<string> {
    this.#emptyTree ??= await this.#checked(["git", "mktree"]);
    return this.#emptyTree;
  }

  #requireFutureLease(leaseExpiresAt: string): void {
    const expiresAt = Date.parse(leaseExpiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.#clock.now().getTime())
      throw new Error("Claim lease must expire in the future");
  }

  #run(argv: readonly string[]): Promise<CommandResult> {
    return this.#git.run(argv, this.#repository);
  }

  async #checked(argv: readonly string[]): Promise<string> {
    const result = await this.#run(argv);
    if (result.exitCode !== 0)
      throw new Error(`Git command failed (${result.exitCode}): ${result.stderr.trim()}`);
    return result.stdout.trim();
  }
}

export function heldClaim(state: ClaimLockState): ClaimLockRecord | undefined {
  return state.record && state.record.action !== "release" ? state.record : undefined;
}

function heldBy(state: ClaimLockState, claim: ClaimRef): ClaimLockRecord {
  const held = heldClaim(state);
  if (held?.claim !== claim) throw new ClaimCollisionError("Claim lock is not held by this claim");
  return held;
}

function releaseRecord(
  state: ClaimLockState,
  authorizedBy?: ClaimLockRecord["owner"],
): ClaimLockRecord {
  const held = heldClaim(state);
  if (!held) throw new ClaimCollisionError("Claim lock is not held");
  const { authorizedBy: _, ...record } = held;
  return { ...record, action: "release", ...(authorizedBy ? { authorizedBy } : {}) };
}
