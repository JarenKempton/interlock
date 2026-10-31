import { z } from "zod";
import { CLAIM_RECORD_VERSION } from "../../domain/claim-lock.ts";
import {
  AmbiguousTrackerResultError,
  ArtifactLinkConflictError,
  ClaimCollisionError,
} from "../../domain/contracts.ts";
import { actorRefSchema, mapRefSchema, ticketRefSchema } from "../../domain/identifiers.ts";
import type {
  ActorRef,
  Dependency,
  MapRef,
  Ticket,
  TicketKind,
  TicketRef,
} from "../../domain/model.ts";
import { parseRef } from "../../domain/reference.ts";
import type {
  MirrorClaim,
  MirrorExpectation,
  MirrorRestore,
  Tracker,
  TrackerRead,
} from "../../domain/tracker.ts";
import { fetchTransport, type HttpTransport } from "./http.ts";

export interface JiraResponse<T = unknown> {
  status: number;
  body?: T;
}

/** Credential-bearing HTTP is a platform concern; the domain adapter only receives this handle. */
export interface JiraTransport {
  request(method: string, path: string, body?: unknown): Promise<JiraResponse>;
}

export interface JiraCredentials {
  site: string;
  email: string;
  token: string;
}

export function jiraBasicAuthTransport(
  credentials: JiraCredentials,
  http: HttpTransport = fetchTransport,
): JiraTransport {
  const origin = jiraOrigin(credentials.site);
  const authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64")}`;
  return {
    async request(method, path, body) {
      if (!path.startsWith("/rest/")) throw new Error("Jira request path must be a REST path");
      const response = await http(`${origin}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!text) return { status: response.status };
      try {
        return { status: response.status, body: JSON.parse(text) };
      } catch {
        return { status: response.status };
      }
    },
  };
}

export function jiraOrigin(site: string): string {
  let url: URL;
  try {
    url = new URL(site.includes("://") ? site : `https://${site}`);
  } catch {
    throw new Error("Jira site must be an https site origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Jira site must be an https site origin");
  return url.origin;
}

const jiraStatusSchema = z.object({
  name: z.string(),
  statusCategory: z.object({ key: z.string().optional() }).optional(),
});
const linkedIssueSchema = z.object({
  key: z.string(),
  fields: z.object({ status: jiraStatusSchema }),
});
const issueSchema = z.object({
  key: z.string(),
  fields: z.looseObject({
    updated: z.string(),
    assignee: z.object({ accountId: z.string() }).nullable(),
    status: jiraStatusSchema,
    issuetype: z.object({ name: z.string() }),
    parent: z.object({ key: z.string() }).optional(),
    issuelinks: z
      .array(
        z.object({
          type: z.object({ inward: z.string(), outward: z.string() }),
          inwardIssue: linkedIssueSchema.optional(),
          outwardIssue: linkedIssueSchema.optional(),
        }),
      )
      .optional(),
  }),
});
type JiraIssue = z.infer<typeof issueSchema>;
export const claimPropertySchema = z.object({
  claim: z.string(),
  run: z.string(),
  owner: z.string(),
  home: z.string(),
  version: z.literal(CLAIM_RECORD_VERSION),
});
const claimPropertyVersionSchema = z.object({
  value: z.object({ version: z.number().int().optional() }),
});
type JiraClaimProperty = z.infer<typeof claimPropertySchema>;
const claimSnapshotSchema = z.object({
  assignee: z.string().nullable(),
  status: z.string(),
  claim: claimPropertySchema.nullable(),
});
export const pendingJiraWriteSchema = z.object({
  ticket: ticketRefSchema,
  operation: z.string(),
  expected: z.discriminatedUnion("field", [
    z.object({ field: z.literal("claim"), value: claimPropertySchema.nullable() }),
    z.object({ field: z.literal("assignee"), value: z.string().nullable() }),
    z.object({ field: z.literal("status"), value: z.string() }),
  ]),
});
type PendingJiraWrite = z.infer<typeof pendingJiraWriteSchema>;

export class PendingJiraWriteError extends AmbiguousTrackerResultError {
  constructor(readonly pendingWrite: PendingJiraWrite) {
    super(`Jira ${pendingWrite.operation} outcome is unknown: ${JSON.stringify(pendingWrite)}`);
  }
}
const transitionsSchema = z.object({
  transitions: z.array(z.object({ id: z.string(), to: z.object({ name: z.string() }) })),
});
const CLAIMED_STATUS = "In Progress";
const remoteLinkSchema = z.object({ object: z.object({ url: z.string() }) });
const DEFINITE_FAILURES = [400, 401, 403, 404, 405, 409, 415, 422, 429];
const searchPageSchema = z.object({
  issues: z.array(issueSchema).optional(),
  nextPageToken: z.string().optional(),
  isLast: z.boolean().optional(),
});
type JiraClaimSnapshot = z.infer<typeof claimSnapshotSchema>;
export interface JiraTrackerOptions {
  instance: string;
  workspace: string;
  transport: JiraTransport;
  /** Jira's site-specific field id for the standard LexoRank Rank field. */
  rankField?: string;
  claimProperty?: string;
  claimHome?: string;
  pageSize?: number;
  validateClaim?: (ticket: Ticket) => void | Promise<void>;
  journalWrite?: (pending: PendingJiraWrite) => () => void;
}

export class JiraTrackerAdapter implements Tracker {
  readonly #transport: JiraTransport;
  readonly #prefix: string;
  readonly #claimProperty: string;
  readonly #claimHome: string | undefined;
  readonly #rankField: string | undefined;
  readonly #pageSize: number;
  readonly #validateClaim: JiraTrackerOptions["validateClaim"];
  readonly #pendingWrites = new Map<TicketRef, PendingJiraWrite>();
  readonly #journalWrite: JiraTrackerOptions["journalWrite"];
  readonly #completeWrites = new Map<TicketRef, () => void>();

  constructor(options: JiraTrackerOptions) {
    if (options.rankField !== undefined && !options.rankField)
      throw new Error("Jira Rank field id is required");
    if (
      options.pageSize !== undefined &&
      (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    )
      throw new Error("Jira page size must be an integer from 1 to 100");
    this.#transport = options.transport;
    this.#prefix = `jira:${options.instance}:${options.workspace}`;
    this.#claimProperty = options.claimProperty ?? "interlock.claim";
    this.#claimHome = options.claimHome;
    this.#rankField = options.rankField;
    this.#pageSize = options.pageSize ?? 100;
    this.#validateClaim = options.validateClaim;
    this.#journalWrite = options.journalWrite;
  }

  async describe() {
    return { link_artifact: true, transition: true } as const;
  }

  async transition(ticket: TicketRef, status: string): Promise<void> {
    await this.#transition(ticket, status);
  }

  async link_artifact(ticket: TicketRef, url: string, title = url): Promise<void> {
    const existing = await this.#remoteLink(ticket, url);
    if (existing) return sameRemoteLink(existing, url);
    let status: number | undefined;
    try {
      status = (
        await this.#transport.request("POST", this.#remoteLinkPath(ticket), {
          globalId: url,
          object: { url, title },
        })
      ).status;
    } catch {}
    if (status !== undefined && DEFINITE_FAILURES.includes(status))
      throw new Error(`Jira link artifact failed (${status})`);
    let installed: z.infer<typeof remoteLinkSchema> | undefined;
    try {
      installed = await this.#remoteLink(ticket, url);
    } catch {
      throw new AmbiguousTrackerResultError("Jira remote link readback failed");
    }
    if (!installed) throw new AmbiguousTrackerResultError("Jira remote link was not verified");
    if (installed.object.url !== url)
      throw new AmbiguousTrackerResultError(
        "Jira remote link readback does not match the artifact",
      );
  }

  async #remoteLink(
    ticket: TicketRef,
    globalId: string,
  ): Promise<z.infer<typeof remoteLinkSchema> | undefined> {
    const response = await this.#transport.request(
      "GET",
      `${this.#remoteLinkPath(ticket)}?globalId=${encodeURIComponent(globalId)}`,
    );
    if (response.status === 404) return undefined;
    if (response.status !== 200)
      throw new Error(`Jira remote link read failed (${response.status})`);
    const parsed = remoteLinkSchema.safeParse(response.body);
    if (!parsed.success) throw new Error("Invalid Jira remote link response");
    return parsed.data;
  }

  #remoteLinkPath(ticket: TicketRef): string {
    return `/rest/api/3/issue/${this.#ticketKey(ticket)}/remotelink`;
  }

  async read(ticket: TicketRef): Promise<TrackerRead> {
    this.#readConfiguration();
    const issue = await this.#issue(ticket);
    const parent = issue.fields.parent?.key;
    if (!parent) throw new Error("Jira ticket has no parent map");
    const map = mapRefSchema.parse(`${this.#prefix}:map:${parent}`);
    const tickets = await this.list_work(map);
    const found = tickets.find((item) => item.ref === ticket);
    if (!found) throw new Error(`Jira ticket is not a child of its reported map: ${ticket}`);
    const latest = await this.#issue(ticket);
    if (latest.fields.parent?.key !== parent)
      throw new Error("Jira ticket changed maps during read; retry pickup");
    return {
      ticket: this.#normalize(latest, ticket, map, found.order),
      snapshot: { version: latest.fields.updated, payload: await this.#claimState(ticket, latest) },
    };
  }

  async list_work(map: MapRef): Promise<Ticket[]> {
    this.#readConfiguration();
    const mapKey = this.#mapKey(map);
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.#required(
        "POST",
        "/rest/api/3/search/jql",
        {
          jql: `parent = ${JSON.stringify(mapKey)} ORDER BY Rank ASC`,
          fields: this.#fields(),
          maxResults: this.#pageSize,
          ...(nextPageToken ? { nextPageToken } : {}),
        },
        "search map tickets",
        searchPageSchema,
      );
      if (!Array.isArray(page.issues)) throw new Error("Invalid Jira search page");
      issues.push(...page.issues);
      if (page.isLast === true || !page.nextPageToken) break;
      if (page.nextPageToken === nextPageToken) throw new Error("Jira search page token repeated");
      nextPageToken = page.nextPageToken;
    } while (nextPageToken !== undefined);
    return issues.map((issue, order) =>
      this.#normalize(issue, this.#ticketRef(issue.key), map, order),
    );
  }

  async claimMarker(ticket: TicketRef): Promise<JiraClaimProperty | null> {
    return this.#readClaim(ticket);
  }

  async apply(request: MirrorClaim): Promise<void> {
    const home = this.#requireClaimHome();
    const property: JiraClaimProperty = {
      claim: request.claim,
      run: request.run,
      owner: request.owner,
      home,
      version: CLAIM_RECORD_VERSION,
    };
    const issue = await this.#issue(request.ticket);
    const current = await this.#claimState(request.ticket, issue);
    if (this.#validateClaim && current.claim?.claim !== request.claim) {
      const parent = issue.fields.parent?.key;
      if (!parent) throw new ClaimCollisionError("Jira ticket no longer has a parent map");
      await this.#validateClaim(
        this.#normalize(
          issue,
          request.ticket,
          mapRefSchema.parse(`${this.#prefix}:map:${parent}`),
          0,
        ),
      );
    }
    if (current.claim !== null && !sameClaimIdentity(current.claim, property))
      throw new ClaimCollisionError(
        `Jira ticket is marked by another claim in claim home ${current.claim.home}`,
      );
    if (current.assignee !== null && current.assignee !== request.owner)
      throw new ClaimCollisionError("Jira ticket is assigned to someone else");
    try {
      await this.#mirror(request.ticket, property, current);
      await this.verify({ ...request, state: "applied" });
    } catch (error) {
      if (error instanceof PendingJiraWriteError) throw error;
      throw new AmbiguousTrackerResultError(
        `Jira mirror apply could not be verified: ${String(error)}`,
      );
    }
  }

  async verify(request: MirrorExpectation): Promise<void> {
    if (request.state === "restored") return this.#verifyRestored(request);
    await this.#verifyApplied(request);
  }

  async #verifyApplied(request: MirrorClaim): Promise<void> {
    const home = this.#requireClaimHome();
    const current = await this.#verifiedClaimState(request.ticket);
    if (
      current.assignee !== request.owner ||
      current.status !== CLAIMED_STATUS ||
      !current.claim ||
      !sameClaimIdentity(current.claim, {
        claim: request.claim,
        run: request.run,
        owner: request.owner,
        home,
        version: CLAIM_RECORD_VERSION,
      })
    )
      throw new AmbiguousTrackerResultError("Jira claim mirror could not be verified");
  }

  async restore(request: MirrorRestore): Promise<void> {
    const home = this.#requireClaimHome();
    const owner = requireClaimedOwner(request.claimedOwner);
    const original = originalClaimState(request);
    await this.#settlePendingWrite(request.ticket);
    const current = await this.#claimState(request.ticket);
    if (current.claim?.claim !== request.claim) return;
    if (current.claim.home !== home)
      throw new ClaimCollisionError(
        `Jira claim property names claim home ${current.claim.home}, not ${home}`,
      );
    if (
      current.claim.owner !== owner ||
      (current.assignee !== owner && current.assignee !== original.assignee) ||
      (current.status !== CLAIMED_STATUS && current.status !== original.status)
    )
      throw new ClaimCollisionError("Jira claim mirror was changed outside Interlock");
    try {
      if (current.status !== original.status)
        await this.#transition(request.ticket, original.status);
      if (current.assignee !== original.assignee)
        await this.#assign(request.ticket, original.assignee);
      const path = this.#propertyPath(request.ticket);
      await this.#write(original.claim ? "PUT" : "DELETE", path, original.claim ?? undefined, {
        ticket: request.ticket,
        operation: "restore claim property",
        expected: { field: "claim", value: original.claim },
      });
      await this.verify({ ...request, state: "restored" });
    } catch (error) {
      if (error instanceof PendingJiraWriteError) throw error;
      throw new AmbiguousTrackerResultError(
        `Jira mirror restore could not be verified: ${String(error)}`,
      );
    }
  }

  async #verifyRestored(request: MirrorRestore): Promise<void> {
    this.#requireClaimHome();
    const owner = requireClaimedOwner(request.claimedOwner);
    const original = originalClaimState(request);
    await this.#settlePendingWrite(request.ticket);
    const current = await this.#verifiedClaimState(request.ticket);
    if (
      current.claim?.claim === request.claim ||
      (current.assignee === owner && current.assignee !== original.assignee) ||
      (current.status === CLAIMED_STATUS && current.status !== original.status)
    )
      throw new AmbiguousTrackerResultError("Jira restored state could not be verified");
  }

  #requireClaimHome(): string {
    if (!this.#claimHome) throw new Error("Jira claim mirror requires a claim home");
    return this.#claimHome;
  }

  #readConfiguration() {
    if (!this.#rankField) throw new Error("Jira normalized reads require Rank configuration");
    return this.#rankField;
  }

  #normalize(issue: JiraIssue, ref: TicketRef, map: MapRef, order: number): Ticket {
    const rankField = this.#readConfiguration();
    const rank = issue.fields[rankField];
    if (typeof rank !== "string" || rank.length === 0)
      throw new Error(`Jira Rank field is missing or invalid: ${rankField}`);
    const dependencies: Dependency[] = [];
    const dependents: Dependency[] = [];
    for (const link of issue.fields.issuelinks ?? []) {
      if (!link.type.inward.toLowerCase().includes("blocked by")) continue;
      if (link.inwardIssue)
        dependencies.push({
          blocking: this.#ticketRef(link.inwardIssue.key),
          blocked: ref,
          kind: "blocks",
        });
      if (link.outwardIssue)
        dependents.push({
          blocking: ref,
          blocked: this.#ticketRef(link.outwardIssue.key),
          kind: "blocks",
        });
    }
    const description = jiraDescription(issue.fields.description);
    return {
      ref,
      map,
      ...(typeof issue.fields.summary === "string" ? { title: issue.fields.summary } : {}),
      ...(description === undefined ? {} : { description }),
      kind: this.#kind(issue.fields.issuetype.name),
      state: issue.fields.status.statusCategory?.key === "done" ? "closed" : "open",
      status: issue.fields.status.name,
      ...(issue.fields.assignee
        ? { assignee: actorRefSchema.parse(issue.fields.assignee.accountId) }
        : {}),
      dependencies,
      dependents,
      order,
      metadata: {
        nativeKey: issue.key,
        version: issue.fields.updated,
        versionSource: "jira.fields.updated",
        rank,
      },
    };
  }

  async #issue(ticket: TicketRef): Promise<JiraIssue> {
    return this.#required(
      "GET",
      `/rest/api/3/issue/${this.#ticketKey(ticket)}?fields=${this.#fields().join(",")}`,
      undefined,
      "read issue",
      issueSchema,
    );
  }

  async #claimState(ticket: TicketRef, read?: JiraIssue): Promise<JiraClaimSnapshot> {
    const issue = read ?? (await this.#issue(ticket));
    return {
      assignee: issue.fields.assignee?.accountId ?? null,
      status: issue.fields.status.name,
      claim: await this.#readClaim(ticket),
    };
  }

  async #verifiedClaimState(ticket: TicketRef): Promise<JiraClaimSnapshot> {
    try {
      return await this.#claimState(ticket);
    } catch (error) {
      throw new AmbiguousTrackerResultError(`Jira mirror readback failed: ${String(error)}`);
    }
  }

  async #mirror(
    ticket: TicketRef,
    property: JiraClaimProperty,
    current: JiraClaimSnapshot,
  ): Promise<void> {
    if (!current.claim || !sameClaimIdentity(current.claim, property))
      await this.#writeClaimProperty(ticket, property);
    if (current.assignee !== property.owner) await this.#assign(ticket, property.owner);
    if (current.status !== CLAIMED_STATUS) await this.#transition(ticket, CLAIMED_STATUS);
  }

  async #writeClaimProperty(ticket: TicketRef, property: JiraClaimProperty): Promise<void> {
    await this.#write("PUT", this.#propertyPath(ticket), property, {
      ticket,
      operation: "set claim property",
      expected: { field: "claim", value: property },
    });
    const installed = await this.#readClaim(ticket);
    if (!installed || !sameClaimIdentity(installed, property))
      throw new AmbiguousTrackerResultError("Jira claim property was not verified");
  }

  async #assign(ticket: TicketRef, accountId: string | null): Promise<void> {
    await this.#write(
      "PUT",
      `/rest/api/3/issue/${this.#ticketKey(ticket)}/assignee`,
      { accountId },
      { ticket, operation: "assign issue", expected: { field: "assignee", value: accountId } },
    );
    if ((await this.#verifiedClaimState(ticket)).assignee !== accountId)
      throw new AmbiguousTrackerResultError("Jira assignment was not verified");
  }

  async #transition(ticket: TicketRef, status: string): Promise<void> {
    const path = `/rest/api/3/issue/${this.#ticketKey(ticket)}/transitions`;
    const { transitions } = await this.#required(
      "GET",
      path,
      undefined,
      "read transitions",
      transitionsSchema,
    );
    const transition = transitions.find((item) => item.to.name === status);
    if (!transition) throw new Error(`Jira has no transition to ${status}`);
    await this.#write(
      "POST",
      path,
      { transition: { id: transition.id } },
      {
        ticket,
        operation: "transition issue",
        expected: { field: "status", value: status },
      },
    );
    if ((await this.#verifiedClaimState(ticket)).status !== status)
      throw new AmbiguousTrackerResultError("Jira transition was not verified");
  }

  async #write(
    method: string,
    path: string,
    body: unknown,
    pending: PendingJiraWrite,
  ): Promise<void> {
    await this.#settlePendingWrite(pending.ticket);
    const complete = this.#journalWrite?.(structuredClone(pending));
    this.#pendingWrites.set(pending.ticket, pending);
    if (complete) this.#completeWrites.set(pending.ticket, complete);
    let response: JiraResponse;
    try {
      response = await this.#transport.request(method, path, body);
    } catch {
      throw new PendingJiraWriteError(pending);
    }
    if (response.status >= 200 && response.status < 300 && response.status !== 202) {
      this.#completeWrite(pending.ticket);
      return;
    }
    if (DEFINITE_FAILURES.includes(response.status)) {
      this.#completeWrite(pending.ticket);
      throw new Error(`Jira ${pending.operation} failed (${response.status})`);
    }
    throw new PendingJiraWriteError(pending);
  }

  async verifyPendingWrite(pending: PendingJiraWrite): Promise<void> {
    let current: JiraClaimSnapshot;
    try {
      current = await this.#claimState(pending.ticket);
    } catch {
      throw new PendingJiraWriteError(pending);
    }
    if (JSON.stringify(current[pending.expected.field]) !== JSON.stringify(pending.expected.value))
      throw new PendingJiraWriteError(pending);
  }

  pendingWrite(ticket: TicketRef): PendingJiraWrite | undefined {
    const pending = this.#pendingWrites.get(ticket);
    return pending ? structuredClone(pending) : undefined;
  }

  async #settlePendingWrite(ticket: TicketRef): Promise<void> {
    const pending = this.#pendingWrites.get(ticket);
    if (!pending) return;
    await this.verifyPendingWrite(pending);
    this.#completeWrite(ticket);
  }

  #completeWrite(ticket: TicketRef): void {
    this.#completeWrites.get(ticket)?.();
    this.#completeWrites.delete(ticket);
    this.#pendingWrites.delete(ticket);
  }

  #propertyPath(ticket: TicketRef): string {
    return `/rest/api/3/issue/${this.#ticketKey(ticket)}/properties/${encodeURIComponent(this.#claimProperty)}`;
  }

  async #readClaim(ticket: TicketRef): Promise<JiraClaimProperty | null> {
    const property = await this.#transport.request("GET", this.#propertyPath(ticket));
    if (property.status !== 200 && property.status !== 404)
      throw new Error(`Jira property read failed (${property.status})`);
    if (property.status === 404) return null;
    return parseClaimProperty(property.body, this.#claimProperty, this.#ticketKey(ticket));
  }

  #fields(): string[] {
    return [
      "summary",
      "description",
      "updated",
      "assignee",
      "status",
      "issuetype",
      "parent",
      "issuelinks",
      ...(this.#rankField ? [this.#rankField] : []),
    ];
  }

  async #required<T>(
    method: string,
    path: string,
    body: unknown,
    operation: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await this.#transport.request(method, path, body);
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Jira ${operation} failed (${response.status})`);
    if (response.body === undefined) throw new Error(`Jira ${operation} returned no body`);
    const parsed = schema.safeParse(response.body);
    if (!parsed.success) throw new Error(`Invalid Jira ${operation} response`);
    return parsed.data;
  }

  #ticketKey(ref: TicketRef): string {
    return encodeURIComponent(this.#nativeKey(ref, "ticket"));
  }

  #mapKey(ref: MapRef): string {
    return this.#nativeKey(ref, "map");
  }

  #nativeKey(ref: TicketRef | MapRef, kind: "ticket" | "map"): string {
    const parsed = parseRef(ref);
    if (
      parsed.kind !== kind ||
      parsed.adapter !== "jira" ||
      !parsed.nativeId ||
      `${parsed.adapter}:${parsed.instance}:${parsed.workspace}` !== this.#prefix
    )
      throw new Error(`${kind} is outside Jira workspace: ${ref}`);
    return parsed.nativeId;
  }

  #ticketRef(key: string): TicketRef {
    return ticketRefSchema.parse(`${this.#prefix}:ticket:${key}`);
  }

  #kind(name: string): TicketKind {
    const value = name.toLowerCase();
    return value === "research" || value === "prototype" || value === "decision" ? value : "task";
  }
}

function sameRemoteLink(link: z.infer<typeof remoteLinkSchema>, url: string): void {
  if (link.object.url !== url)
    throw new ArtifactLinkConflictError(
      "Jira holds a different remote link under this artifact id",
    );
}

function sameClaimIdentity(left: JiraClaimProperty, right: JiraClaimProperty): boolean {
  return (
    left.claim === right.claim &&
    left.run === right.run &&
    left.owner === right.owner &&
    left.home === right.home &&
    left.version === right.version
  );
}

function originalClaimState(request: MirrorRestore): JiraClaimSnapshot {
  const parsed = claimSnapshotSchema.safeParse(request.originalSnapshot.payload);
  if (!parsed.success) throw new Error("Invalid Jira original claim snapshot");
  return parsed.data;
}

function requireClaimedOwner(owner: ActorRef | undefined): ActorRef {
  if (!owner) throw new Error("Persisted claimed owner is required");
  return owner;
}

/** Jira ADF -> readable text. Preserve block/list boundaries and link destinations. */
export function jiraDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  function render(value: unknown): string {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid Jira description document");
    const node = z.record(z.string(), z.unknown()).parse(value);
    if (typeof node.type !== "string") throw new Error("Invalid Jira description node");
    if (node.type === "text") {
      if (typeof node.text !== "string") throw new Error("Invalid Jira description text");
      const marks = Array.isArray(node.marks) ? node.marks : [];
      const link = marks.find((mark) => mark?.type === "link")?.attrs?.href;
      return node.text + (typeof link === "string" ? ` (${link})` : "");
    }
    if (node.type === "hardBreak") return "\n";
    const attrs = z.record(z.string(), z.unknown()).safeParse(node.attrs).data ?? {};
    if (node.type === "mention")
      return typeof attrs.text === "string"
        ? attrs.text
        : typeof attrs.id === "string"
          ? `@${attrs.id}`
          : "[Jira mention]";
    if (node.type === "inlineCard" || node.type === "blockCard")
      return typeof attrs.url === "string"
        ? attrs.url + (node.type === "blockCard" ? "\n" : "")
        : "[Jira link card unavailable]";
    if (node.type === "emoji" || node.type === "status")
      return typeof attrs.text === "string"
        ? attrs.text
        : typeof attrs.shortName === "string"
          ? attrs.shortName
          : "[Jira label]";
    if (node.type === "date")
      return typeof attrs.timestamp === "string" ? attrs.timestamp : "[Jira date]";
    if (node.type === "rule") return "\n---\n";
    if (node.content !== undefined && !Array.isArray(node.content))
      throw new Error("Invalid Jira description content");
    const content = z
      .array(z.unknown())
      .parse(node.content ?? [])
      .map(render)
      .join("");
    if (node.type === "heading") {
      const level = z.number().int().min(1).max(6).safeParse(attrs.level).data ?? 1;
      return `${"#".repeat(level)} ${content.trimEnd()}\n`;
    }
    if (node.type === "codeBlock") return `\n\`\`\`\n${content}\n\`\`\`\n`;
    if (["paragraph", "listItem", "blockquote", "tableRow"].includes(node.type))
      return `${content.trimEnd()}\n`;
    if (
      ["doc", "bulletList", "orderedList", "table", "tableCell", "tableHeader", "panel"].includes(
        node.type,
      )
    )
      return content;
    if (node.type === "expand" || node.type === "nestedExpand")
      return `${typeof attrs.title === "string" ? attrs.title : ""}\n${content}`;
    return `[Unsupported Jira content]${content}`;
  }
  return render(value).trimEnd();
}

export function parseClaimProperty(
  body: unknown,
  property: string,
  key: string,
): JiraClaimProperty {
  const version = claimPropertyVersionSchema.safeParse(body);
  if (!version.success) throw new Error("Invalid Jira claim property");
  const found = version.data.value.version;
  if (found === undefined || found < CLAIM_RECORD_VERSION)
    throw new Error(
      `Jira ${property} on ${key} was written before claim homes; remove the ${property} property from ${key} and refs/interlock/claims/${key} from the claim remote to clear it`,
    );
  if (found > CLAIM_RECORD_VERSION)
    throw new Error(
      `Jira ${property} on ${key} is version ${found}; upgrade Interlock before touching it`,
    );
  const parsed = z.object({ value: claimPropertySchema }).safeParse(body);
  if (!parsed.success) throw new Error("Invalid Jira claim property");
  return parsed.data.value;
}
