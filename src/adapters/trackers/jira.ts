import { z } from "zod";
import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
  type FrontierTrackerAdapter,
  type ReclaimRequest,
  type ReleaseClaimRequest,
  type RenewLeaseRequest,
  type RestoreClaimRequest,
} from "../../domain/contracts.ts";
import { actorRefSchema, mapRefSchema, ticketRefSchema } from "../../domain/identifiers.ts";
import {
  type ActorRef,
  capabilities,
  type Dependency,
  type MapRef,
  type Ticket,
  type TicketKind,
  type TicketRef,
  type TrackerSnapshot,
  UnsupportedCapabilityError,
} from "../../domain/model.ts";
import { parseRef } from "../../domain/reference.ts";
import { fetchTransport, type HttpTransport } from "./http.ts";

export interface JiraResponse<T = unknown> {
  status: number;
  body?: T;
}

/** Credential-bearing HTTP is a platform concern; the domain adapter only receives this handle. */
export interface JiraTransport {
  request(method: string, path: string, body?: unknown): Promise<JiraResponse>;
}

export function jiraBasicAuthTransport(
  environment: Record<string, string | undefined> = process.env,
  http: HttpTransport = fetchTransport,
): JiraTransport {
  const origin = jiraOrigin(requiredVariable(environment, "JIRA_SITE"));
  const credentials = `${requiredVariable(environment, "JIRA_USER_EMAIL")}:${requiredVariable(environment, "JIRA_API_TOKEN")}`;
  const authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
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

function requiredVariable(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required for Jira`);
  return value;
}

function jiraOrigin(site: string): string {
  let url: URL;
  try {
    url = new URL(site.includes("://") ? site : `https://${site}`);
  } catch {
    throw new Error("JIRA_SITE must be an https Jira site origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("JIRA_SITE must be an https Jira site origin");
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
    priority: z.object({ name: z.string().optional() }).optional(),
  }),
});
type JiraIssue = z.infer<typeof issueSchema>;
const claimPropertySchema = z.object({
  claim: z.string(),
  run: z.string(),
  owner: z.string(),
  supersedes: z.string().optional(),
});
type JiraClaimProperty = z.infer<typeof claimPropertySchema>;
const claimSnapshotSchema = z.object({
  assignee: z.string().nullable(),
  status: z.string(),
  claim: claimPropertySchema.nullable(),
});
const transitionsSchema = z.object({
  transitions: z.array(z.object({ id: z.string(), to: z.object({ name: z.string() }) })),
});
const CLAIMED_STATUS = "In Progress";
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
  rankField: string;
  /** Highest-priority name first; Jira numeric IDs have no portable semantic ordering. */
  priorityOrder: readonly string[];
  claimProperty?: string;
  pageSize?: number;
}

const MUTATION_CAPABILITIES = [
  "atomic_assignment",
  "conditional_update",
  "claim_identity",
  "claim_comments",
  "lease_metadata",
] as const;

export function jiraCapabilities() {
  return capabilities("native_maps", "native_dependencies");
}

/**
 * Jira Cloud adapter. Jira has no conditional write, so claim methods only mirror ownership that a
 * GitLockedTrackerAdapter already holds; they never advertise conditional capabilities.
 */
export class JiraTrackerAdapter implements FrontierTrackerAdapter {
  readonly #transport: JiraTransport;
  readonly #prefix: string;
  readonly #claimProperty: string;
  readonly #priorityOrder: readonly string[];
  readonly #rankField: string;
  readonly #pageSize: number;

  constructor(options: JiraTrackerOptions) {
    if (!options.rankField) throw new Error("Jira Rank field id is required");
    if (options.priorityOrder.length === 0) throw new Error("Jira priority order is required");
    if (
      options.pageSize !== undefined &&
      (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    )
      throw new Error("Jira page size must be an integer from 1 to 100");
    this.#transport = options.transport;
    this.#prefix = `jira:${options.instance}:${options.workspace}`;
    this.#claimProperty = options.claimProperty ?? "interlock.claim";
    this.#priorityOrder = options.priorityOrder;
    this.#rankField = options.rankField;
    this.#pageSize = options.pageSize ?? 100;
  }

  async describe() {
    return jiraCapabilities();
  }

  async preflight(ticket: TicketRef): Promise<void> {
    await this.getTicket(ticket);
  }

  async getTicket(ticket: TicketRef): Promise<Ticket> {
    const issue = await this.#issue(ticket);
    const parent = issue.fields.parent?.key;
    if (!parent) throw new Error("Jira ticket has no parent map");
    const map = mapRefSchema.parse(`${this.#prefix}:map:${parent}`);
    const tickets = await this.listMapTickets(map);
    const found = tickets.find((item) => item.ref === ticket);
    if (!found) throw new Error(`Jira ticket is not a child of its reported map: ${ticket}`);
    return found;
  }

  async listMapTickets(map: MapRef): Promise<Ticket[]> {
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

  async snapshotClaimState(ticket: TicketRef): Promise<TrackerSnapshot> {
    const issue = await this.#issue(ticket);
    return { version: issue.fields.updated, payload: await this.#claimState(ticket, issue) };
  }

  async claim(request: ClaimRequest): Promise<void> {
    const current = await this.#claimState(request.ticket);
    if (
      (current.assignee !== null && current.assignee !== request.owner) ||
      (current.claim !== null && current.claim.claim !== request.claim)
    )
      throw new ClaimCollisionError("Jira ticket is assigned or marked by another claim");
    await this.#mirror(
      request.ticket,
      { claim: request.claim, run: request.run, owner: request.owner },
      current,
    );
  }

  async verifyClaim(request: ClaimRequest): Promise<void> {
    const current = await this.#claimState(request.ticket);
    if (
      current.assignee !== request.owner ||
      current.status !== CLAIMED_STATUS ||
      current.claim?.claim !== request.claim ||
      current.claim.run !== request.run ||
      current.claim.owner !== request.owner
    )
      throw new AmbiguousTrackerResultError("Jira claim mirror could not be verified");
  }

  async restoreClaimState(request: RestoreClaimRequest): Promise<void> {
    const owner = requireClaimedOwner(request.claimedOwner);
    const original = originalClaimState(request);
    const current = await this.#claimState(request.ticket);
    if (current.claim?.claim !== request.claim) return;
    if (
      (current.assignee !== owner && current.assignee !== original.assignee) ||
      (current.status !== CLAIMED_STATUS && current.status !== original.status)
    )
      throw new ClaimCollisionError("Jira claim mirror was changed outside Interlock");
    if (current.status !== original.status) await this.#transition(request.ticket, original.status);
    if (current.assignee !== original.assignee)
      await this.#assign(request.ticket, original.assignee);
    const path = this.#propertyPath(request.ticket);
    if (original.claim) await this.#write("PUT", path, original.claim, "restore claim property");
    else await this.#write("DELETE", path, undefined, "delete claim property");
  }

  async verifyRestored(request: RestoreClaimRequest): Promise<void> {
    const owner = requireClaimedOwner(request.claimedOwner);
    const original = originalClaimState(request);
    const current = await this.#claimState(request.ticket);
    if (
      current.claim?.claim === request.claim ||
      (current.assignee === owner && current.assignee !== original.assignee) ||
      (current.status === CLAIMED_STATUS && current.status !== original.status)
    )
      throw new AmbiguousTrackerResultError("Jira restored state could not be verified");
  }

  async renewLease(request: RenewLeaseRequest): Promise<void> {
    await this.verifyLease(request);
  }

  async verifyLease(request: RenewLeaseRequest): Promise<void> {
    if ((await this.#claimState(request.ticket)).claim?.claim !== request.claim)
      throw new AmbiguousTrackerResultError("Jira ticket is no longer marked by this claim");
  }

  async releaseClaim(request: ReleaseClaimRequest): Promise<void> {
    await this.restoreClaimState(request);
  }

  async verifyReleased(request: ReleaseClaimRequest): Promise<void> {
    await this.verifyRestored(request);
  }

  async reclaim(request: ReclaimRequest): Promise<void> {
    const current = await this.#claimState(request.ticket);
    if (current.claim?.claim !== request.staleClaim && current.claim?.claim !== request.claim)
      throw new ClaimCollisionError("Jira ticket is not marked by the stale claim");
    await this.#mirror(
      request.ticket,
      {
        claim: request.claim,
        run: request.run,
        owner: request.owner,
        supersedes: request.staleClaim,
      },
      current,
    );
  }

  async verifyReclaimed(request: ReclaimRequest): Promise<void> {
    const current = await this.#claimState(request.ticket);
    if (
      current.assignee !== request.owner ||
      current.status !== CLAIMED_STATUS ||
      current.claim?.claim !== request.claim ||
      current.claim.supersedes !== request.staleClaim
    )
      throw new AmbiguousTrackerResultError("Jira reclaim mirror could not be verified");
  }

  async addComment(_ticket: TicketRef, _text: string): Promise<void> {
    this.#mutationUnavailable();
  }

  async resolve(_ticket: TicketRef, _status = "Done"): Promise<void> {
    this.#mutationUnavailable();
  }

  #normalize(issue: JiraIssue, ref: TicketRef, map: MapRef, order: number): Ticket {
    const rank = issue.fields[this.#rankField];
    if (typeof rank !== "string" || rank.length === 0)
      throw new Error(`Jira Rank field is missing or invalid: ${this.#rankField}`);
    const priorityName = issue.fields.priority?.name;
    const priorityIndex = priorityName ? this.#priorityOrder.indexOf(priorityName) : -1;
    if (priorityName && priorityIndex < 0)
      throw new Error(`Jira priority is not configured: ${priorityName}`);
    const dependencies: Dependency[] = [];
    for (const link of issue.fields.issuelinks ?? []) {
      if (link.inwardIssue && link.type.inward.toLowerCase().includes("blocked by")) {
        dependencies.push({
          blocking: this.#ticketRef(link.inwardIssue.key),
          blocked: ref,
          kind: "blocks",
        });
      }
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
      order,
      ...(priorityIndex >= 0 ? { priority: this.#priorityOrder.length - priorityIndex } : {}),
      metadata: {
        nativeKey: issue.key,
        version: issue.fields.updated,
        versionSource: "jira.fields.updated",
        rank,
        priorityName,
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

  async #mirror(
    ticket: TicketRef,
    property: JiraClaimProperty,
    current: JiraClaimSnapshot,
  ): Promise<void> {
    await this.#write("PUT", this.#propertyPath(ticket), property, "set claim property");
    if (current.assignee !== property.owner) await this.#assign(ticket, property.owner);
    if (current.status !== CLAIMED_STATUS) await this.#transition(ticket, CLAIMED_STATUS);
  }

  async #assign(ticket: TicketRef, accountId: string | null): Promise<void> {
    await this.#write(
      "PUT",
      `/rest/api/3/issue/${this.#ticketKey(ticket)}/assignee`,
      { accountId },
      "assign issue",
    );
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
    await this.#write("POST", path, { transition: { id: transition.id } }, "transition issue");
  }

  async #write(method: string, path: string, body: unknown, operation: string): Promise<void> {
    const response = await this.#transport.request(method, path, body);
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Jira ${operation} failed (${response.status})`);
  }

  #propertyPath(ticket: TicketRef): string {
    return `/rest/api/3/issue/${this.#ticketKey(ticket)}/properties/${encodeURIComponent(this.#claimProperty)}`;
  }

  async #readClaim(ticket: TicketRef): Promise<JiraClaimProperty | null> {
    const property = await this.#transport.request("GET", this.#propertyPath(ticket));
    if (property.status !== 200 && property.status !== 404)
      throw new Error(`Jira property read failed (${property.status})`);
    if (property.status === 404) return null;
    const parsed = z.object({ value: claimPropertySchema.optional() }).safeParse(property.body);
    if (!parsed.success) throw new Error("Invalid Jira claim property");
    return parsed.data.value ?? null;
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
      "priority",
      this.#rankField,
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

  #mutationUnavailable(): never {
    throw new UnsupportedCapabilityError(MUTATION_CAPABILITIES);
  }
}

function originalClaimState(request: RestoreClaimRequest): JiraClaimSnapshot {
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
