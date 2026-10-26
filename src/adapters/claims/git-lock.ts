import { z } from "zod";
import { type ClaimHome, normalizeClaimHome } from "../../domain/claim-home.ts";
import {
  CLAIM_RECORD_VERSION,
  type ClaimLockRecord,
  type ClaimLockState,
  type RecoverableClaimLock,
} from "../../domain/claim-lock.ts";
import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
  type Clock,
  type ReleaseClaimRequest,
} from "../../domain/contracts.ts";
import {
  actorRefSchema,
  claimRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../../domain/identifiers.ts";
import type { ClaimRef, TicketRef } from "../../domain/model.ts";
import { parseRef } from "../../domain/reference.ts";
import {
  BunGitCommandExecutor,
  type CommandResult,
  type GitCommandExecutor,
} from "../workspaces/git.ts";

export const ABSENT_LOCK_VERSION = "absent";
export const CLAIM_LOCK_NAMESPACE = `refs/interlock/v${CLAIM_RECORD_VERSION}`;

const recordVersionSchema = z.object({ version: z.number().int() });
const lockRecordSchema = z.strictObject({
  action: z.enum(["claim", "release"]),
  ticket: ticketRefSchema,
  claim: claimRefSchema,
  run: runRefSchema,
  owner: actorRefSchema,
  leaseExpiresAt: z.string(),
  home: z.string(),
  version: z.literal(CLAIM_RECORD_VERSION),
  authorizedBy: actorRefSchema.optional(),
});

export interface GitClaimLockOptions {
  repository: string;
  home: ClaimHome;
  git?: GitCommandExecutor;
  clock?: Clock;
  beforeClaimWrite?: () => void;
}

export class GitClaimLock implements RecoverableClaimLock {
  readonly #repository: string;
  readonly #home: ClaimHome;
  readonly #git: GitCommandExecutor;
  readonly #clock: Clock;
  readonly #beforeClaimWrite: (() => void) | undefined;
  readonly #pendingWrites = new Map<TicketRef, { version: string; commit: string }>();
  #emptyTree?: string;

  constructor(options: GitClaimLockOptions) {
    if (!options.repository || !options.home.url || !options.home.identity)
      throw new Error("Claim lock repository and claim home are required");
    this.#repository = options.repository;
    this.#home = options.home;
    this.#git = options.git ?? new BunGitCommandExecutor();
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#beforeClaimWrite = options.beforeClaimWrite;
  }

  async describe(): Promise<{ conditional_update: true }> {
    return { conditional_update: true };
  }

  async ref(ticket: TicketRef): Promise<string> {
    const { instance, nativeId: key } = parseRef(ticket);
    const ref = `${CLAIM_LOCK_NAMESPACE}/${instance}/${key}`;
    if (
      !instance ||
      !key ||
      instance.includes("/") ||
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
      home: this.#home.identity,
      version: CLAIM_RECORD_VERSION,
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
      push = await this.#run(["git", "push", "--porcelain", this.#home.url, `${commit}:${ref}`]);
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
      throw new Error(
        `Claim lock push to claim home ${this.#home.identity} was rejected: ${rejected.trim()}`,
      );
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
    const output = await this.#checked(["git", "ls-remote", this.#home.url, ref]);
    const line = output
      .split(/\r?\n/)
      .map((item) => item.split("\t"))
      .find((item) => item[1] === ref);
    return line?.[0] || null;
  }

  async #verifyRemote(): Promise<void> {
    const expanded = await this.#checked(["git", "ls-remote", "--get-url", this.#home.url]);
    if (identityOf(expanded) !== this.#home.identity)
      throw new Error(
        `Claim lock destination for claim home ${this.#home.identity} is rewritten to another remote`,
      );
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
      if (this.#home.url.startsWith(prefix) || expanded.startsWith(prefix))
        throw new Error(
          `Claim lock push to claim home ${this.#home.identity} is rewritten; remove the pushInsteadOf rule`,
        );
    }
  }

  async #record(ref: string, tip: string): Promise<ClaimLockRecord> {
    if ((await this.#run(["git", "cat-file", "-e", `${tip}^{commit}`])).exitCode !== 0)
      await this.#checked(["git", "fetch", "--no-tags", this.#home.url, ref]);
    const commit = await this.#checked(["git", "cat-file", "commit", tip]);
    const message = commit.slice(commit.indexOf("\n\n") + 2);
    let value: unknown;
    try {
      value = JSON.parse(message.slice(message.indexOf("\n\n") + 2));
    } catch {
      throw new Error(`Invalid claim lock record at ${ref} ${tip}`);
    }
    const version = recordVersionSchema.safeParse(value);
    if (version.success && version.data.version > CLAIM_RECORD_VERSION)
      throw new Error(
        `Claim lock record at ${ref} is version ${version.data.version}; upgrade Interlock before touching it`,
      );
    const record = lockRecordSchema.safeParse(value);
    if (!record.success) throw new Error(`Invalid claim lock record at ${ref} ${tip}`);
    if (record.data.home !== this.#home.identity)
      throw new Error(`Claim lock record at ${ref} belongs to claim home ${record.data.home}`);
    return record.data;
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

function identityOf(remote: string): string | undefined {
  try {
    return normalizeClaimHome(remote).identity;
  } catch {
    return undefined;
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
