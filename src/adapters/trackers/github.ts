import type { FrontierTrackerAdapter } from "../../domain/contracts.ts";
import { actorRefSchema, mapRefSchema, ticketRefSchema } from "../../domain/identifiers.ts";
import {
  type ActorRef,
  type CapabilitySet,
  capabilities,
  type MapRef,
  type Ticket,
  type TicketKind,
  type TicketRef,
} from "../../domain/model.ts";
import { parseRef } from "../../domain/reference.ts";
import { type AssignmentState, AssignmentTrackerAdapter } from "./common.ts";
import {
  fetchTransport,
  type HttpResponse,
  type HttpTransport,
  object,
  responseJson,
  string,
} from "./http.ts";

export interface GitHubAdapterOptions {
  token: string;
  apiBase?: string;
  transport?: HttpTransport;
  pageSize?: number;
}

export const GITHUB_API_VERSION = "2026-03-10";

export class GitHubWorkspaceBoundaryError extends Error {
  readonly code = "cross_workspace_reference";

  constructor(
    readonly expectedWorkspace: string,
    readonly actualWorkspace: string,
    readonly entity: "map" | "ticket",
  ) {
    super(
      `GitHub ${entity} belongs to ${actualWorkspace}, outside configured workspace ${expectedWorkspace}`,
    );
    this.name = "GitHubWorkspaceBoundaryError";
  }
}

export class GitHubIssuesTrackerAdapter
  extends AssignmentTrackerAdapter
  implements FrontierTrackerAdapter
{
  readonly #token: string;
  readonly #apiBase: string;
  readonly #transport: HttpTransport;
  readonly #pageSize: number;

  constructor(options: GitHubAdapterOptions) {
    super();
    if (!options.token) throw new Error("GitHub token is required");
    if (
      options.pageSize !== undefined &&
      (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    ) {
      throw new Error("GitHub page size must be an integer from 1 to 100");
    }
    this.#token = options.token;
    this.#apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.#transport = options.transport ?? fetchTransport;
    this.#pageSize = options.pageSize ?? 100;
  }

  async describe(): Promise<CapabilitySet> {
    return capabilities("native_maps", "native_dependencies");
  }

  async preflight(ticket: TicketRef): Promise<void> {
    await this.getTicket(ticket);
  }

  async getTicket(ticket: TicketRef): Promise<Ticket> {
    const parsed = githubRef(ticket, "ticket");
    const issue = object(await this.#get(this.#issueUrl(parsed)), "GitHub issue");
    const actual = issueRef(parsed, issue, "ticket");
    if (actual !== ticket) {
      throw new Error("GitHub issue repository does not match its qualified ticket reference");
    }
    const parent = object(await this.#get(`${this.#issueUrl(parsed)}/parent`), "GitHub parent");
    const map = issueRef(parsed, parent, "map");
    const blockers = await this.#paginate(`${this.#issueUrl(parsed)}/dependencies/blocked_by`);
    return this.#normalize(issue, ticket, map, 0, blockers);
  }

  async listMapTickets(map: MapRef): Promise<Ticket[]> {
    const parsed = githubRef(map, "map");
    const children = await this.#paginate(`${this.#issueUrl(parsed)}/sub_issues`);
    const normalized: Ticket[] = [];
    for (const [order, child] of children.entries()) {
      if (child.pull_request !== undefined) continue;
      const ref = issueRef(parsed, child, "ticket");
      const childRef = githubRef(ref, "ticket");
      const blockers = await this.#paginate(`${this.#issueUrl(childRef)}/dependencies/blocked_by`);
      normalized.push(this.#normalize(child, ref, map, order, blockers));
    }
    return normalized;
  }

  async readAssignment(ticket: TicketRef): Promise<AssignmentState> {
    const parsed = githubRef(ticket, "ticket");
    const response = await this.#request(this.#issueUrl(parsed));
    const issue = object(await responseJson(response, "GitHub issue read"), "GitHub issue");
    const assignees = issue.assignees;
    if (!Array.isArray(assignees)) throw new Error("Invalid GitHub assignees");
    if (assignees.length > 1)
      throw new Error("GitHub issue has multiple assignees and is not claimable");
    const assignee = assignees[0]
      ? actorRefSchema.parse(
          string(object(assignees[0], "GitHub assignee").login, "assignee login"),
        )
      : undefined;
    const version = response.headers.get("etag") ?? string(issue.updated_at, "issue updated_at");
    return { version, ...(assignee ? { assignee } : {}) };
  }

  async writeAssignment(ticket: TicketRef, assignee?: ActorRef): Promise<void> {
    const parsed = githubRef(ticket, "ticket");
    await this.#request(this.#issueUrl(parsed), "PATCH", { assignees: assignee ? [assignee] : [] });
  }

  #normalize(
    issue: Record<string, unknown>,
    ref: TicketRef,
    map: MapRef,
    order: number,
    blockers: Record<string, unknown>[],
  ): Ticket {
    if (issue.pull_request !== undefined)
      throw new Error("GitHub pull requests are not Wayfinder tickets");
    const labels = issue.labels;
    if (!Array.isArray(labels)) throw new Error("Invalid GitHub issue labels");
    const kind = kindFromLabels(
      labels.map((label) =>
        typeof label === "string"
          ? label
          : string(object(label, "GitHub label").name, "label name"),
      ),
    );
    const assignees = issue.assignees;
    if (!Array.isArray(assignees)) throw new Error("Invalid GitHub issue assignees");
    if (assignees.length > 1) {
      throw new Error("GitHub issue has multiple assignees and cannot be normalized");
    }
    const assignee = assignees[0]
      ? actorRefSchema.parse(
          string(object(assignees[0], "GitHub assignee").login, "assignee login"),
        )
      : undefined;
    const parsed = githubRef(ref, "ticket");
    return {
      ref,
      map,
      ...(typeof issue.title === "string" ? { title: issue.title } : {}),
      ...(typeof issue.body === "string" ? { description: issue.body } : {}),
      kind,
      state: issue.state === "closed" ? "closed" : "open",
      status: string(issue.state, "issue state"),
      ...(assignee ? { assignee } : {}),
      dependencies: blockers.map((blocker) => ({
        blocking: issueRef(parsed, blocker, "ticket"),
        blocked: ref,
        kind: "blocks",
      })),
      order,
      metadata: {
        number: issue.number,
        version: string(issue.updated_at, "issue updated_at"),
        versionSource: "github.updated_at",
        url: string(issue.html_url, "issue html_url"),
      },
    };
  }

  async #paginate(url: string): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [];
    let next: string | undefined =
      `${url}${url.includes("?") ? "&" : "?"}per_page=${this.#pageSize}`;
    while (next) {
      const response = await this.#request(next);
      const page = await responseJson(response, "GitHub paginated read");
      if (!Array.isArray(page)) throw new Error("Invalid GitHub paginated response");
      result.push(...page.map((item) => object(item, "GitHub page item")));
      const link = nextLink(response.headers.get("link"));
      next = link ? this.#authorizedUrl(link, next) : undefined;
    }
    return result;
  }

  async #get(url: string): Promise<unknown> {
    const response = await this.#request(url);
    return responseJson(response, "GitHub request");
  }

  async #request(url: string, method = "GET", body?: unknown): Promise<HttpResponse> {
    const authorizedUrl = this.#authorizedUrl(url);
    const response = await this.#transport(authorizedUrl, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.#token}`,
        "User-Agent": "interlock",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status < 200 || response.status >= 300) {
      await responseJson(response, `GitHub ${method}`);
    }
    return response;
  }

  #authorizedUrl(value: string, base = this.#apiBase): string {
    const configured = new URL(this.#apiBase);
    const candidate = new URL(value, base);
    if (candidate.origin !== configured.origin) {
      throw new Error("GitHub pagination URL is outside the configured API origin");
    }
    return candidate.toString();
  }

  #issueUrl(ref: ReturnType<typeof githubRef>): string {
    const [owner, repository, extra] = ref.workspace.split("/");
    if (!owner || !repository || extra)
      throw new Error("GitHub workspace must be owner/repository");
    return `${this.#apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${encodeURIComponent(ref.nativeId)}`;
  }
}

function nextLink(value: string | null): string | undefined {
  if (!value) return undefined;
  for (const part of value.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"/.exec(part);
    if (match?.[2] === "next") return match[1];
  }
  return undefined;
}

function kindFromLabels(labels: string[]): TicketKind {
  const matches = labels
    .map((label) =>
      /^wayfinder:(task|research|prototype|decision)$/i.exec(label)?.[1]?.toLowerCase(),
    )
    .filter((value): value is TicketKind => value !== undefined);
  const kind = matches[0];
  if (matches.length !== 1 || kind === undefined) {
    throw new Error("GitHub issue must have exactly one Wayfinder type label");
  }
  return kind;
}

function githubRef(ref: string, kind: "map" | "ticket") {
  const parsed = parseRef(ref);
  if (
    parsed.adapter !== "github" ||
    parsed.kind !== kind ||
    !parsed.nativeId ||
    !parsed.instance ||
    !parsed.workspace
  ) {
    throw new Error(`Expected a qualified GitHub ${kind} reference`);
  }
  return {
    ...parsed,
    adapter: "github",
    nativeId: parsed.nativeId,
    instance: parsed.instance,
    workspace: parsed.workspace,
  };
}

function issueRef(
  context: ReturnType<typeof githubRef>,
  issue: Record<string, unknown>,
  kind: "map",
): MapRef;
function issueRef(
  context: ReturnType<typeof githubRef>,
  issue: Record<string, unknown>,
  kind: "ticket",
): TicketRef;
function issueRef(
  context: ReturnType<typeof githubRef>,
  issue: Record<string, unknown>,
  kind: "map" | "ticket",
): MapRef | TicketRef {
  const repositoryUrl = string(issue.repository_url, "issue repository_url");
  const url = new URL(repositoryUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const repos = parts.lastIndexOf("repos");
  const owner = parts[repos + 1];
  const repository = parts[repos + 2];
  if (repos < 0 || !owner || !repository || parts.length !== repos + 3) {
    throw new Error("Invalid GitHub issue repository identity");
  }
  const number = String(issue.number);
  if (!/^\d+$/.test(number)) throw new Error("Invalid GitHub issue number");
  const workspace = `${owner}/${repository}`;
  if (workspace.toLowerCase() !== context.workspace.toLowerCase()) {
    throw new GitHubWorkspaceBoundaryError(context.workspace, workspace, kind);
  }
  const value = `github:${context.instance}:${workspace}:${kind}:${number}`;
  return kind === "map" ? mapRefSchema.parse(value) : ticketRefSchema.parse(value);
}
