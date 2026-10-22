import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type {
  ClaimRequest,
  ReclaimRequest,
  ReleaseClaimRequest,
  RenewLeaseRequest,
  RestoreClaimRequest,
  TrackerAdapter,
} from "../../domain/contracts.ts";
import { AmbiguousTrackerResultError, ClaimCollisionError } from "../../domain/contracts.ts";
import {
  actorRefSchema,
  claimRefSchema,
  groupRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
  workspaceRefSchema,
} from "../../domain/identifiers.ts";
import {
  type ActorRef,
  type ClaimRef,
  capabilities,
  type MapRef,
  type Ticket,
  type TicketRef,
  type TrackerSnapshot,
  type WorkspaceRef,
} from "../../domain/model.ts";
import { parseRef } from "../../domain/reference.ts";
import { evaluateFrontier, type FrontierScope } from "../../frontier/evaluate.ts";

const FENCE = "interlock-tracker";
const RENDERED_START = "<!-- interlock-rendered:start -->";
const RENDERED_END = "<!-- interlock-rendered:end -->";
const OPEN_FENCE = /^[ \t]{0,3}```interlock-tracker[ \t]*$/m;
const CLOSE_FENCE = /^[ \t]{0,3}```[ \t]*$/m;

export interface MarkdownTrackerClock {
  now(): Date;
}

export interface MarkdownMapRecord {
  ref: MapRef;
  title: string;
  order: number;
  context: string[];
}

export interface MarkdownClaimRecord {
  ref: ClaimRef;
  run: ClaimRequest["run"];
  owner: ClaimRequest["owner"];
  claimedAt: string;
  leaseExpiresAt: string;
  status: "active" | "superseded";
  supersedes?: ClaimRef;
  supersededBy?: ClaimRef;
}

export interface MarkdownTicketRecord extends Ticket {
  title: string;
  claim?: MarkdownClaimRecord;
  claimHistory: MarkdownClaimRecord[];
  comments: string[];
  artifacts: string[];
}

export interface MarkdownTrackerDocument {
  format: "interlock-markdown-tracker";
  version: number;
  workspace: WorkspaceRef;
  maps: MarkdownMapRecord[];
  tickets: MarkdownTicketRecord[];
}

export interface MarkdownResolveRequest {
  ticket: TicketRef;
  expectedVersion: string;
  resolution: string;
  owner?: ActorRef;
  claim?: ClaimRef;
  artifacts?: readonly string[];
}

export interface MarkdownLockOwner {
  token: string;
  pid: number;
  host: string;
  createdAt: string;
}

export type MarkdownLockInspection =
  | { state: "absent" }
  | { state: "live" | "orphaned" | "unknown"; owner?: MarkdownLockOwner; reason?: string };

interface ClaimPayload {
  assignee?: Ticket["assignee"];
  status: string;
  claim?: MarkdownClaimRecord;
}

export class MarkdownTrackerValidationError extends Error {
  readonly code = "invalid_markdown_tracker";

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`Invalid Interlock Markdown tracker at ${path}: ${message}`);
    this.name = "MarkdownTrackerValidationError";
  }
}

export class MarkdownTrackerLockError extends Error {
  readonly code = "tracker_lock_held";

  constructor(readonly inspection: MarkdownLockInspection) {
    super(`Markdown tracker lock is ${inspection.state}`);
    this.name = "MarkdownTrackerLockError";
  }
}

export class MarkdownTrackerAdapter implements TrackerAdapter {
  readonly path: string;
  readonly #clock: MarkdownTrackerClock;

  constructor(path: string, clock: MarkdownTrackerClock = { now: () => new Date() }) {
    this.path = resolve(path);
    this.#clock = clock;
  }

  async describe() {
    return capabilities(
      "native_maps",
      "native_dependencies",
      "cross_map_dependencies",
      "atomic_assignment",
      "workflow_transition",
      "conditional_update",
      "claim_comments",
      "claim_identity",
      "lease_metadata",
      "resolution_comments",
      "artifact_links",
    );
  }

  async preflight(ticket: TicketRef): Promise<void> {
    await this.getTicket(ticket);
    await this.#withLock(async () => undefined);
  }

  async getTicket(ticket: TicketRef): Promise<Ticket> {
    return structuredClone(this.#ticket(await this.read(), ticket));
  }

  async listTickets(): Promise<Ticket[]> {
    const document = await this.read();
    return structuredClone(
      document.tickets.map((ticket) => ({
        ...ticket,
        metadata: {
          ...ticket.metadata,
          version: String(document.version),
          versionSource: "markdown.document.version",
        },
      })),
    );
  }

  async frontier(scope: FrontierScope = {}): Promise<Ticket[]> {
    return evaluateFrontier(await this.listTickets(), scope, {
      availableStatuses: new Set(["To Do"]),
    });
  }

  async snapshotClaimState(ticket: TicketRef): Promise<TrackerSnapshot> {
    const document = await this.read();
    return {
      version: String(document.version),
      payload: this.#claimPayload(this.#ticket(document, ticket)),
    };
  }

  async claim(request: ClaimRequest): Promise<void> {
    const now = this.#clock.now();
    this.#requireFutureLease(request.leaseExpiresAt, now);
    await this.#mutate(request.expectedVersion, (document) => {
      const ticket = this.#ticket(document, request.ticket);
      if (ticket.state !== "open" || ticket.assignee !== undefined || ticket.claim !== undefined) {
        throw new ClaimCollisionError("Ticket is already claimed or closed");
      }
      ticket.assignee = request.owner;
      ticket.status = "In Progress";
      ticket.claim = {
        ref: request.claim,
        run: request.run,
        owner: request.owner,
        claimedAt: now.toISOString(),
        leaseExpiresAt: request.leaseExpiresAt,
        status: "active",
      };
      ticket.comments.push(`Claimed by ${request.owner} as ${request.claim} for ${request.run}.`);
      return undefined;
    });
  }

  async verifyClaim(request: ClaimRequest): Promise<void> {
    const ticket = this.#ticket(await this.read(), request.ticket);
    if (
      ticket.assignee !== request.owner ||
      ticket.claim?.ref !== request.claim ||
      ticket.claim.run !== request.run ||
      ticket.claim.leaseExpiresAt !== request.leaseExpiresAt ||
      ticket.status !== "In Progress"
    ) {
      throw new AmbiguousTrackerResultError("Claim could not be verified");
    }
  }

  async restoreClaimState(request: RestoreClaimRequest): Promise<void> {
    await this.#mutate(undefined, (document) => {
      const ticket = this.#ticket(document, request.ticket);
      const original = this.#snapshotPayload(request.originalSnapshot);
      if (this.#payloadsEqual(this.#claimPayload(ticket), original)) return false;
      if (ticket.claim?.ref !== request.claim) throw new ClaimCollisionError();
      this.#restorePayload(ticket, original);
      ticket.comments.push(`Restored claim state after ${request.claim}.`);
      return undefined;
    });
  }

  async verifyRestored(request: RestoreClaimRequest): Promise<void> {
    const ticket = this.#ticket(await this.read(), request.ticket);
    if (
      !this.#payloadsEqual(
        this.#claimPayload(ticket),
        this.#snapshotPayload(request.originalSnapshot),
      )
    ) {
      throw new AmbiguousTrackerResultError("Restored claim state could not be verified");
    }
  }

  async renewLease(request: RenewLeaseRequest): Promise<void> {
    this.#requireFutureLease(request.leaseExpiresAt, this.#clock.now());
    await this.#mutate(request.expectedVersion, (document) => {
      this.#matchingClaim(document, request.ticket, request.claim).leaseExpiresAt =
        request.leaseExpiresAt;
      return undefined;
    });
  }

  async verifyLease(request: RenewLeaseRequest): Promise<void> {
    const claim = this.#matchingClaim(await this.read(), request.ticket, request.claim);
    if (claim.leaseExpiresAt !== request.leaseExpiresAt) {
      throw new AmbiguousTrackerResultError("Lease renewal could not be verified");
    }
  }

  async releaseClaim(request: ReleaseClaimRequest): Promise<void> {
    await this.#mutate(request.expectedVersion, (document) => {
      const ticket = this.#ticket(document, request.ticket);
      if (ticket.claim?.ref !== request.claim || ticket.claim.owner !== request.authorizedBy) {
        throw new ClaimCollisionError("Claim or authorized owner no longer matches");
      }
      this.#restorePayload(ticket, this.#snapshotPayload(request.originalSnapshot));
      ticket.comments.push(`Released ${request.claim}; authorized by ${request.authorizedBy}.`);
      return undefined;
    });
  }

  async verifyReleased(request: ReleaseClaimRequest): Promise<void> {
    await this.verifyRestored(request);
  }

  async reclaim(request: ReclaimRequest): Promise<void> {
    const now = this.#clock.now();
    this.#requireFutureLease(request.leaseExpiresAt, now);
    await this.#mutate(request.expectedVersion, (document) => {
      const ticket = this.#ticket(document, request.ticket);
      const prior = ticket.claim;
      if (
        !prior ||
        prior.ref !== request.staleClaim ||
        prior.status !== "active" ||
        Date.parse(prior.leaseExpiresAt) > now.getTime()
      ) {
        throw new ClaimCollisionError("Claim is not stale or no longer matches");
      }
      prior.status = "superseded";
      prior.supersededBy = request.claim;
      ticket.claimHistory.push(structuredClone(prior));
      ticket.assignee = request.owner;
      ticket.claim = {
        ref: request.claim,
        run: request.run,
        owner: request.owner,
        claimedAt: now.toISOString(),
        leaseExpiresAt: request.leaseExpiresAt,
        status: "active",
        supersedes: request.staleClaim,
      };
      ticket.comments.push(
        `Reclaimed ${request.staleClaim} as ${request.claim}; authorized by ${request.authorizedBy}.`,
      );
      return undefined;
    });
  }

  async verifyReclaimed(request: ReclaimRequest): Promise<void> {
    const ticket = this.#ticket(await this.read(), request.ticket);
    if (
      ticket.assignee !== request.owner ||
      ticket.claim?.ref !== request.claim ||
      ticket.claim.supersedes !== request.staleClaim ||
      ticket.claim.leaseExpiresAt !== request.leaseExpiresAt
    ) {
      throw new AmbiguousTrackerResultError("Reclaim could not be verified");
    }
  }

  async comment(ticketRef: TicketRef, body: string, expectedVersion: string): Promise<void> {
    await this.#mutate(expectedVersion, (document) => {
      this.#ticket(document, ticketRef).comments.push(body);
      return undefined;
    });
  }

  async resolve(request: MarkdownResolveRequest): Promise<void> {
    if (!request.resolution.trim())
      throw new Error("A resolution comment is required before close");
    await this.#mutate(request.expectedVersion, (document) => {
      const ticket = this.#ticket(document, request.ticket);
      if (ticket.state === "closed") throw new ClaimCollisionError("Ticket is already closed");
      if (ticket.claim) {
        if (ticket.claim.ref !== request.claim || ticket.claim.owner !== request.owner) {
          throw new ClaimCollisionError("Active claim belongs to another owner or run");
        }
      } else if (ticket.assignee !== undefined && ticket.assignee !== request.owner) {
        throw new ClaimCollisionError("Ticket is assigned to another owner");
      }
      ticket.comments.push(`Resolution: ${request.resolution}`);
      ticket.artifacts.push(...(request.artifacts ?? []));
      ticket.state = "closed";
      ticket.status = "Done";
      delete ticket.assignee;
      delete ticket.claim;
      return undefined;
    });
  }

  async appendMapContext(
    mapRef: MapRef,
    ticketRef: TicketRef,
    gist: string,
    expectedVersion: string,
  ): Promise<void> {
    await this.#mutate(expectedVersion, (document) => {
      const map = document.maps.find((item) => item.ref === mapRef);
      if (!map) throw new Error(`Unknown map: ${mapRef}`);
      const ticket = this.#ticket(document, ticketRef);
      if (ticket.map !== mapRef || ticket.state !== "closed") {
        throw new Error("A map context pointer requires a closed ticket on that map");
      }
      const marker = `[${ticket.title}](${ticket.ref})`;
      if (map.context.some((line) => line.startsWith(`${marker} —`))) {
        throw new ClaimCollisionError("Map context pointer already exists");
      }
      map.context.push(`${marker} — ${gist}`);
      return undefined;
    });
  }

  async read(): Promise<MarkdownTrackerDocument> {
    return parseMarkdownTracker(await readFile(this.path, "utf8"));
  }

  async inspectLock(): Promise<MarkdownLockInspection> {
    let source: string;
    try {
      source = await readFile(this.#lockPath(), "utf8");
    } catch (error) {
      if (
        (error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined) === "ENOENT"
      )
        return { state: "absent" };
      throw error;
    }
    let owner: MarkdownLockOwner;
    try {
      owner = parseLockOwner(JSON.parse(source));
    } catch (error) {
      return { state: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
    if (owner.host !== hostname())
      return { state: "unknown", owner, reason: "lock owner is remote" };
    try {
      process.kill(owner.pid, 0);
      return { state: "live", owner };
    } catch (error) {
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined;
      if (code === "ESRCH") return { state: "orphaned", owner };
      return { state: "unknown", owner, reason: code ?? "process probe failed" };
    }
  }

  async reclaimOrphanedLock(expectedToken: string): Promise<void> {
    const inspection = await this.inspectLock();
    if (inspection.state !== "orphaned" || inspection.owner?.token !== expectedToken) {
      throw new MarkdownTrackerLockError(inspection);
    }
    const confirmed = await this.inspectLock();
    if (confirmed.state !== "orphaned" || confirmed.owner?.token !== expectedToken) {
      throw new MarkdownTrackerLockError(confirmed);
    }
    const quarantine = `${this.#lockPath()}.reclaimed.${crypto.randomUUID()}`;
    await rename(this.#lockPath(), quarantine);
    let tokenMatched = false;
    try {
      const moved = parseLockOwner(JSON.parse(await readFile(quarantine, "utf8")));
      if (moved.token !== expectedToken) {
        throw new MarkdownTrackerLockError({
          state: "unknown",
          owner: moved,
          reason: `lock changed during reclaim; retained at ${quarantine}`,
        });
      }
      tokenMatched = true;
    } finally {
      if (tokenMatched) await rm(quarantine, { force: true });
    }
  }

  async #mutate(
    expectedVersion: string | undefined,
    update: (document: MarkdownTrackerDocument) => undefined | false,
  ): Promise<void> {
    await this.#withLock(async () => {
      const source = await readFile(this.path, "utf8");
      const document = parseMarkdownTracker(source);
      if (expectedVersion !== undefined && String(document.version) !== expectedVersion) {
        throw new ClaimCollisionError();
      }
      if (update(document) === false) return;
      document.version += 1;
      const next = replaceTrackerRegions(source, document);
      parseMarkdownTracker(next);
      await durableAtomicReplace(this.path, next);
    });
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const owner: MarkdownLockOwner = {
      token: crypto.randomUUID(),
      pid: process.pid,
      host: hostname(),
      createdAt: this.#clock.now().toISOString(),
    };
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(this.#lockPath(), "wx");
    } catch (error) {
      if (
        (error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined) === "EEXIST"
      ) {
        throw new MarkdownTrackerLockError(await this.inspectLock());
      }
      throw error;
    }
    try {
      await lock.writeFile(JSON.stringify(owner));
    } catch (error) {
      await lock.close();
      await rm(this.#lockPath(), { force: true });
      throw error;
    }
    try {
      return await operation();
    } finally {
      await lock.close();
      const current = await this.inspectLock();
      if (current.state !== "absent" && current.owner?.token === owner.token) {
        await rm(this.#lockPath(), { force: true });
      }
    }
  }

  #lockPath(): string {
    return `${this.path}.lock`;
  }

  #ticket(document: MarkdownTrackerDocument, ref: TicketRef): MarkdownTicketRecord {
    const ticket = document.tickets.find((item) => item.ref === ref);
    if (!ticket) throw new Error(`Unknown ticket: ${ref}`);
    return ticket;
  }

  #matchingClaim(
    document: MarkdownTrackerDocument,
    ticketRef: TicketRef,
    claimRef: ClaimRef,
  ): MarkdownClaimRecord {
    const claim = this.#ticket(document, ticketRef).claim;
    if (!claim || claim.ref !== claimRef || claim.status !== "active")
      throw new ClaimCollisionError();
    return claim;
  }

  #claimPayload(ticket: MarkdownTicketRecord): ClaimPayload {
    return {
      ...(ticket.assignee === undefined ? {} : { assignee: ticket.assignee }),
      status: ticket.status,
      ...(ticket.claim === undefined ? {} : { claim: structuredClone(ticket.claim) }),
    };
  }

  #snapshotPayload(snapshot: TrackerSnapshot): ClaimPayload {
    return validateClaimPayload(snapshot.payload, "snapshot.payload");
  }

  #restorePayload(ticket: MarkdownTicketRecord, payload: ClaimPayload): void {
    ticket.status = payload.status;
    if (payload.assignee === undefined) delete ticket.assignee;
    else ticket.assignee = payload.assignee;
    if (payload.claim === undefined) delete ticket.claim;
    else ticket.claim = structuredClone(payload.claim);
  }

  #payloadsEqual(left: ClaimPayload, right: ClaimPayload): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  #requireFutureLease(leaseExpiresAt: string, now: Date): void {
    if (!isDate(leaseExpiresAt) || Date.parse(leaseExpiresAt) <= now.getTime()) {
      throw new Error("Lease expiration must be a valid future timestamp");
    }
  }
}

export function parseMarkdownTracker(source: string): MarkdownTrackerDocument {
  const block = locateStateBlock(source);
  let value: unknown;
  try {
    value = JSON.parse(source.slice(block.contentStart, block.contentEnd));
  } catch (error) {
    throw new MarkdownTrackerValidationError(
      "state",
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateDocument(value);
}

export function formatMarkdownTracker(document: MarkdownTrackerDocument): string {
  validateDocument(document);
  return `# Interlock tracker\n\n${renderGenerated(document)}\n\n\`\`\`${FENCE}\n${JSON.stringify(document, null, 2)}\n\`\`\`\n`;
}

/**
 * Syncs complete temporary contents before replacement and parent-directory metadata afterward
 * where the host supports directory handles. Replacement atomicity is exactly that provided by
 * Node/libuv and the destination filesystem; no stronger power-loss guarantee is claimed.
 */
export async function durableAtomicReplace(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"]).has(code ?? "")) throw error;
  } finally {
    await directory?.close();
  }
}

function replaceTrackerRegions(source: string, document: MarkdownTrackerDocument): string {
  validateDocument(document);
  const block = locateStateBlock(source);
  let next = `${source.slice(0, block.openStart)}\`\`\`${FENCE}\n${JSON.stringify(document, null, 2)}\n\`\`\`${source.slice(block.closeEnd)}`;
  const renderedStart = next.indexOf(RENDERED_START);
  const renderedEnd = next.indexOf(RENDERED_END);
  if (renderedStart >= 0 && renderedEnd > renderedStart) {
    next = `${next.slice(0, renderedStart)}${renderGenerated(document)}${next.slice(renderedEnd + RENDERED_END.length)}`;
  }
  return next;
}

function renderGenerated(document: MarkdownTrackerDocument): string {
  const maps = document.maps
    .toSorted((left, right) => left.order - right.order)
    .map((map) => {
      const context = map.context.length
        ? map.context.map((line) => `- ${safeRendered(line)}`).join("\n")
        : "_None yet._";
      return `## ${safeRendered(map.title)}\n\n### Decisions so far\n\n${context}`;
    })
    .join("\n\n");
  return `${RENDERED_START}\n${maps}\n${RENDERED_END}`;
}

function safeRendered(value: string): string {
  return value.replace(/^[ \t]{0,3}```interlock-tracker[ \t]*$/gm, "\\```interlock-tracker");
}

function locateStateBlock(source: string) {
  const open = OPEN_FENCE.exec(source);
  if (!open)
    throw new MarkdownTrackerValidationError("state", `missing line-anchored ${FENCE} fence`);
  const contentStart =
    open.index + open[0].length + (source[open.index + open[0].length] === "\r" ? 2 : 1);
  const tail = source.slice(contentStart);
  const close = CLOSE_FENCE.exec(tail);
  if (!close) throw new MarkdownTrackerValidationError("state", "unterminated state fence");
  const duplicate = OPEN_FENCE.exec(tail.slice(close.index + close[0].length));
  if (duplicate)
    throw new MarkdownTrackerValidationError("state", "multiple tracker fences are not allowed");
  return {
    openStart: open.index,
    contentStart,
    contentEnd: contentStart + close.index,
    closeEnd: contentStart + close.index + close[0].length,
  };
}

function validateDocument(value: unknown): MarkdownTrackerDocument {
  const item = object(value, "document");
  exactKeys(item, ["format", "version", "workspace", "maps", "tickets"], "document");
  equal(item.format, "interlock-markdown-tracker", "document.format");
  integer(item.version, "document.version", 0);
  const workspace = workspaceRefSchema.parse(string(item.workspace, "document.workspace"));
  const workspaceParts = qualifiedRef(workspace, "workspace", "document.workspace");
  const maps = array(item.maps, "document.maps").map((value, index) => validateMap(value, index));
  const tickets = array(item.tickets, "document.tickets").map((value, index) =>
    validateTicket(value, index),
  );
  unique(
    maps.map((map) => map.ref),
    "document.maps[].ref",
  );
  unique(
    tickets.map((ticket) => ticket.ref),
    "document.tickets[].ref",
  );
  const mapRefs = new Set(maps.map((map) => map.ref));
  const ticketRefs = new Set(tickets.map((ticket) => ticket.ref));
  for (const [index, ticket] of tickets.entries()) {
    if (!mapRefs.has(ticket.map))
      invalid(`document.tickets[${index}].map`, "references unknown map");
    for (const [dependencyIndex, dependency] of (ticket.dependencies ?? []).entries()) {
      if (dependency.blocked !== ticket.ref)
        invalid(
          `document.tickets[${index}].dependencies[${dependencyIndex}].blocked`,
          "must equal containing ticket ref",
        );
      if (!ticketRefs.has(dependency.blocking))
        invalid(
          `document.tickets[${index}].dependencies[${dependencyIndex}].blocking`,
          "references unknown ticket",
        );
    }
  }
  for (const [index, map] of maps.entries()) {
    sameWorkspace(
      qualifiedRef(map.ref, "map", `document.maps[${index}].ref`),
      workspaceParts,
      `document.maps[${index}].ref`,
    );
  }
  for (const [index, ticket] of tickets.entries()) {
    sameWorkspace(
      qualifiedRef(ticket.ref, "ticket", `document.tickets[${index}].ref`),
      workspaceParts,
      `document.tickets[${index}].ref`,
    );
    if (ticket.group)
      sameWorkspace(
        qualifiedRef(ticket.group, "group", `document.tickets[${index}].group`),
        workspaceParts,
        `document.tickets[${index}].group`,
      );
    for (const [dependencyIndex, dependency] of (ticket.dependencies ?? []).entries()) {
      sameWorkspace(
        qualifiedRef(
          dependency.blocking,
          "ticket",
          `document.tickets[${index}].dependencies[${dependencyIndex}].blocking`,
        ),
        workspaceParts,
        `document.tickets[${index}].dependencies[${dependencyIndex}].blocking`,
      );
      sameWorkspace(
        qualifiedRef(
          dependency.blocked,
          "ticket",
          `document.tickets[${index}].dependencies[${dependencyIndex}].blocked`,
        ),
        workspaceParts,
        `document.tickets[${index}].dependencies[${dependencyIndex}].blocked`,
      );
    }
  }
  return {
    format: "interlock-markdown-tracker",
    version: z.number().parse(item.version),
    workspace,
    maps,
    tickets,
  };
}

function validateMap(value: unknown, index: number): MarkdownMapRecord {
  const path = `document.maps[${index}]`;
  const item = object(value, path);
  exactKeys(item, ["ref", "title", "order", "context"], path);
  return {
    ref: mapRefSchema.parse(string(item.ref, `${path}.ref`)),
    title: string(item.title, `${path}.title`),
    order: integer(item.order, `${path}.order`, 0),
    context: stringArray(item.context, `${path}.context`),
  };
}

function validateTicket(value: unknown, index: number): MarkdownTicketRecord {
  const path = `document.tickets[${index}]`;
  const item = object(value, path);
  exactKeys(
    item,
    [
      "ref",
      "map",
      "group",
      "kind",
      "state",
      "status",
      "assignee",
      "dependencies",
      "order",
      "priority",
      "metadata",
      "title",
      "description",
      "acceptanceCriteria",
      "claim",
      "claimHistory",
      "comments",
      "artifacts",
    ],
    path,
  );
  const kind = oneOf(
    item.kind,
    ["task", "research", "prototype", "decision"] as const,
    `${path}.kind`,
  );
  const state = oneOf(item.state, ["open", "closed"] as const, `${path}.state`);
  const dependencies =
    item.dependencies === undefined
      ? undefined
      : array(item.dependencies, `${path}.dependencies`).map((entry, dependencyIndex) => {
          const dependencyPath = `${path}.dependencies[${dependencyIndex}]`;
          const dependency = object(entry, dependencyPath);
          exactKeys(dependency, ["blocking", "blocked", "kind"], dependencyPath);
          equal(dependency.kind, "blocks", `${dependencyPath}.kind`);
          return {
            blocking: ticketRefSchema.parse(
              string(dependency.blocking, `${dependencyPath}.blocking`),
            ),
            blocked: ticketRefSchema.parse(string(dependency.blocked, `${dependencyPath}.blocked`)),
            kind: "blocks" as const,
          };
        });
  const claim = item.claim === undefined ? undefined : validateClaim(item.claim, `${path}.claim`);
  const claimHistory = array(item.claimHistory, `${path}.claimHistory`).map((entry, claimIndex) =>
    validateClaim(entry, `${path}.claimHistory[${claimIndex}]`),
  );
  unique(
    claimHistory.map((historicalClaim) => historicalClaim.ref),
    `${path}.claimHistory[].ref`,
  );
  for (const [claimIndex, historicalClaim] of claimHistory.entries()) {
    if (historicalClaim.status !== "superseded" || !historicalClaim.supersededBy) {
      invalid(
        `${path}.claimHistory[${claimIndex}]`,
        "must be superseded and identify its successor",
      );
    }
    const successor = claimHistory[claimIndex + 1] ?? claim;
    if (
      successor &&
      (historicalClaim.supersededBy !== successor.ref ||
        successor.supersedes !== historicalClaim.ref)
    ) {
      invalid(`${path}.claimHistory[${claimIndex}]`, "does not form a reciprocal claim chain");
    }
  }
  return {
    ref: ticketRefSchema.parse(string(item.ref, `${path}.ref`)),
    map: mapRefSchema.parse(string(item.map, `${path}.map`)),
    ...(item.group === undefined
      ? {}
      : { group: groupRefSchema.parse(string(item.group, `${path}.group`)) }),
    kind,
    state,
    status: string(item.status, `${path}.status`),
    ...(item.assignee === undefined
      ? {}
      : { assignee: actorRefSchema.parse(string(item.assignee, `${path}.assignee`)) }),
    ...(dependencies ? { dependencies } : {}),
    order: integer(item.order, `${path}.order`, 0),
    ...(item.priority === undefined
      ? {}
      : { priority: integer(item.priority, `${path}.priority`) }),
    ...(item.metadata === undefined ? {} : { metadata: object(item.metadata, `${path}.metadata`) }),
    title: string(item.title, `${path}.title`),
    ...(item.description === undefined
      ? {}
      : { description: string(item.description, `${path}.description`) }),
    ...(item.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: string(item.acceptanceCriteria, `${path}.acceptanceCriteria`) }),
    ...(claim ? { claim } : {}),
    claimHistory,
    comments: stringArray(item.comments, `${path}.comments`),
    artifacts: stringArray(item.artifacts, `${path}.artifacts`),
  };
}

function qualifiedRef(value: string, kind: "workspace" | "group" | "map" | "ticket", path: string) {
  let parsed: ReturnType<typeof parseRef>;
  try {
    parsed = parseRef(value);
  } catch (error) {
    invalid(path, error instanceof Error ? error.message : "must be a qualified reference");
  }
  if (parsed.kind !== kind) invalid(path, `must be a qualified ${kind} reference`);
  if (parsed.adapter !== "markdown") invalid(path, 'adapter must be "markdown"');
  return parsed;
}

function sameWorkspace(
  value: ReturnType<typeof parseRef>,
  workspace: ReturnType<typeof parseRef>,
  path: string,
): void {
  if (value.instance !== workspace.instance || value.workspace !== workspace.workspace) {
    invalid(path, `must belong to workspace ${workspace.raw}`);
  }
}

function validateClaim(value: unknown, path: string): MarkdownClaimRecord {
  const item = object(value, path);
  exactKeys(
    item,
    ["ref", "run", "owner", "claimedAt", "leaseExpiresAt", "status", "supersedes", "supersededBy"],
    path,
  );
  const claimedAt = date(item.claimedAt, `${path}.claimedAt`);
  const leaseExpiresAt = date(item.leaseExpiresAt, `${path}.leaseExpiresAt`);
  return {
    ref: claimRefSchema.parse(string(item.ref, `${path}.ref`)),
    run: runRefSchema.parse(string(item.run, `${path}.run`)),
    owner: actorRefSchema.parse(string(item.owner, `${path}.owner`)),
    claimedAt,
    leaseExpiresAt,
    status: oneOf(item.status, ["active", "superseded"] as const, `${path}.status`),
    ...(item.supersedes === undefined
      ? {}
      : { supersedes: claimRefSchema.parse(string(item.supersedes, `${path}.supersedes`)) }),
    ...(item.supersededBy === undefined
      ? {}
      : { supersededBy: claimRefSchema.parse(string(item.supersededBy, `${path}.supersededBy`)) }),
  };
}

function validateClaimPayload(value: unknown, path: string): ClaimPayload {
  const item = object(value, path);
  exactKeys(item, ["assignee", "status", "claim"], path);
  return {
    ...(item.assignee === undefined
      ? {}
      : { assignee: actorRefSchema.parse(string(item.assignee, `${path}.assignee`)) }),
    status: string(item.status, `${path}.status`),
    ...(item.claim === undefined ? {} : { claim: validateClaim(item.claim, `${path}.claim`) }),
  };
}

function parseLockOwner(value: unknown): MarkdownLockOwner {
  const item = object(value, "lock");
  exactKeys(item, ["token", "pid", "host", "createdAt"], "lock");
  return {
    token: string(item.token, "lock.token"),
    pid: integer(item.pid, "lock.pid", 1),
    host: string(item.host, "lock.host"),
    createdAt: date(item.createdAt, "lock.createdAt"),
  };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(path, "must be an object");
  return z.record(z.string(), z.unknown()).parse(value);
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  return value;
}
function string(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(path, "must be a string");
  return value;
}
function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => string(item, `${path}[${index}]`));
}
function integer(value: unknown, path: string, minimum?: number): number {
  if (!Number.isSafeInteger(value) || (minimum !== undefined && z.number().parse(value) < minimum))
    invalid(path, `must be an integer${minimum === undefined ? "" : ` >= ${minimum}`}`);
  return z.number().parse(value);
}
function date(value: unknown, path: string): string {
  const result = string(value, path);
  if (!isDate(result)) invalid(path, "must be an ISO-8601 timestamp");
  return result;
}
function isDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
function equal(value: unknown, expected: string, path: string): void {
  if (value !== expected) invalid(path, `must equal ${JSON.stringify(expected)}`);
}
function oneOf<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value))
    invalid(path, `must be one of ${choices.join(", ")}`);
  return z.enum(choices).parse(value);
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) invalid(`${path}.${unexpected}`, "is not supported");
}
function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) invalid(path, "must be unique");
}
function invalid(path: string, message: string): never {
  throw new MarkdownTrackerValidationError(path, message);
}
