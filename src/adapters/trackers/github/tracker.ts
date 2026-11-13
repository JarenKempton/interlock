import { z } from "zod";
import { AmbiguousTrackerResultError, ClaimCollisionError } from "../../../domain/contracts.ts";
import type { ActorRef, MapRef, TicketRef } from "../../../domain/model.ts";
import { actorRefSchema } from "../../../domain/refs/identifiers.ts";
import type {
  AssigneeOnlyTracker,
  MirrorClaim,
  MirrorExpectation,
  MirrorRestore,
  TrackerRead,
} from "../../../domain/tracker/port.ts";
import type { Dependency, Ticket, TicketKind } from "../../../domain/tracker/ticket.ts";
import {
  type IssueAddress,
  issueAddress,
  issueMapRef,
  issueRef,
  repositoryOfApiUrl,
} from "./refs.ts";
import type { GitHubFields, GitHubTransport } from "./transport.ts";

export const INTERLOCK_LABEL = "interlock";
const OPEN_STATUS = "To Do";
const CLOSED_STATUS = "Done";
const PAGE_SIZE = 100;

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  state: z.enum(["open", "closed"]),
  updated_at: z.string(),
  repository_url: z.string(),
  assignees: z.array(z.object({ login: z.string() })),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  type: z.object({ name: z.string() }).nullable().optional(),
  pull_request: z.unknown().optional(),
});
type Issue = z.infer<typeof issueSchema>;
const commentSchema = z.object({ body: z.string().nullable().optional() });
const mirrorSnapshotSchema = z.object({ assignees: z.array(z.string()), labeled: z.boolean() });
type MirrorState = z.infer<typeof mirrorSnapshotSchema> & { state: Issue["state"] };

export interface GitHubIssuesTrackerOptions {
  transport: GitHubTransport;
  claimedStatus?: string;
  validateClaim?: (ticket: Ticket) => void | Promise<void>;
}

export class GitHubIssuesTracker implements AssigneeOnlyTracker {
  readonly mirror = "assignee_only";
  readonly #transport: GitHubTransport;
  readonly #claimedStatus: string;
  readonly #validateClaim: GitHubIssuesTrackerOptions["validateClaim"];

  constructor(options: GitHubIssuesTrackerOptions) {
    this.#transport = options.transport;
    this.#claimedStatus = options.claimedStatus ?? "In Progress";
    this.#validateClaim = options.validateClaim;
  }

  async read(ticket: TicketRef): Promise<TrackerRead> {
    const issue = await this.#issue(issueAddress(ticket));
    return {
      ticket: await this.#normalize(issue),
      snapshot: { version: issue.updated_at, payload: mirrorSnapshot(issue) },
    };
  }

  async listWork(map: MapRef): Promise<Ticket[]> {
    const parent = issueAddress(map);
    const children = await this.#pages(
      `repos/${parent.repository}/issues/${parent.number}/sub_issues`,
      issueSchema,
    );
    const tickets: Ticket[] = [];
    for (const child of children)
      tickets.push(
        (await this.read(issueRef(repositoryOfApiUrl(child.repository_url), child.number))).ticket,
      );
    return tickets;
  }

  async apply(request: MirrorClaim): Promise<void> {
    const address = issueAddress(request.ticket);
    const issue = await this.#issue(address);
    const current = mirrorState(issue);
    const foreign = current.assignees.filter((login) => login !== request.owner);
    if (foreign.length || current.state !== "open")
      throw new ClaimCollisionError("GitHub issue is assigned to someone else or closed");
    const owned = current.assignees.length > 0;
    if (owned && current.labeled) return;
    if (this.#validateClaim && !owned && !current.labeled)
      await this.#validateClaim(await this.#normalize(issue));
    try {
      if (!current.labeled)
        await this.#write("POST", `${issuePath(address)}/labels`, { labels: [INTERLOCK_LABEL] });
      if (!owned)
        await this.#write("POST", `${issuePath(address)}/assignees`, {
          assignees: [request.owner],
        });
    } catch (error) {
      throw new AmbiguousTrackerResultError(`GitHub mirror apply failed: ${String(error)}`);
    }
    await this.#verifyApplied(request);
  }

  async verify(request: MirrorExpectation): Promise<void> {
    if (request.state === "applied") return this.#verifyApplied(request);
    const original = originalMirror(request);
    const current = await this.#readback(request.ticket);
    if (
      (current.assignees.includes(request.claimedOwner) &&
        !original.assignees.includes(request.claimedOwner)) ||
      (current.labeled && !original.labeled)
    )
      throw new AmbiguousTrackerResultError("GitHub restored mirror could not be verified");
  }

  async restore(request: MirrorRestore): Promise<void> {
    const address = issueAddress(request.ticket);
    const original = originalMirror(request);
    const current = mirrorState(await this.#issue(address));
    const owner = request.claimedOwner;
    const removeOwner = current.assignees.includes(owner) && !original.assignees.includes(owner);
    const removeLabel = current.labeled && !original.labeled;
    if (!removeOwner && !removeLabel) return;
    const allowed = new Set([...original.assignees, owner]);
    if (
      current.state !== "open" ||
      current.assignees.some((login) => !allowed.has(login)) ||
      (!current.assignees.includes(owner) && !sameSet(current.assignees, original.assignees))
    )
      throw new ClaimCollisionError("GitHub issue mirror was changed outside Interlock");
    try {
      if (removeLabel) await this.#removeLabel(address);
      if (removeOwner)
        await this.#write("DELETE", `${issuePath(address)}/assignees`, { assignees: [owner] });
    } catch (error) {
      throw new AmbiguousTrackerResultError(`GitHub mirror restore failed: ${String(error)}`);
    }
    await this.verify({ ...request, state: "restored" });
  }

  async removeMirror(request: MirrorClaim): Promise<void> {
    const address = issueAddress(request.ticket);
    const current = mirrorState(await this.#issue(address));
    if (!current.labeled) return;
    if (!sameSet(current.assignees, [request.owner]))
      throw new ClaimCollisionError("GitHub issue is assigned to someone else");
    try {
      await this.#removeLabel(address);
    } catch (error) {
      throw new AmbiguousTrackerResultError(`GitHub mirror removal failed: ${String(error)}`);
    }
    if ((await this.#readback(request.ticket)).labeled)
      throw new AmbiguousTrackerResultError("GitHub mirror removal could not be verified");
  }

  async complete(ticket: TicketRef): Promise<void> {
    const address = issueAddress(ticket);
    if ((await this.#issue(address)).state === "closed") return;
    try {
      await this.#write("PATCH", issuePath(address), {
        state: "closed",
        state_reason: "completed",
      });
    } catch (error) {
      throw new AmbiguousTrackerResultError(`GitHub close failed: ${String(error)}`);
    }
    if ((await this.#readback(ticket)).state !== "closed")
      throw new AmbiguousTrackerResultError("GitHub close could not be verified");
  }

  async linkArtifact(ticket: TicketRef, url: string, title = url): Promise<void> {
    const address = issueAddress(ticket);
    if (await this.#linked(address, url)) return;
    try {
      await this.#write("POST", `${issuePath(address)}/comments`, {
        body: `Linked pull request: [${title.replaceAll(/[[\]]/g, "")}](${url})`,
      });
    } catch (error) {
      throw new AmbiguousTrackerResultError(`GitHub artifact link failed: ${String(error)}`);
    }
    let linked: boolean;
    try {
      linked = await this.#linked(address, url);
    } catch {
      throw new AmbiguousTrackerResultError("GitHub artifact link readback failed");
    }
    if (!linked) throw new AmbiguousTrackerResultError("GitHub artifact link was not verified");
  }

  async #linked(address: IssueAddress, url: string): Promise<boolean> {
    const comments = await this.#pages(`${issuePath(address)}/comments`, commentSchema);
    return comments.some((comment) => comment.body?.includes(`(${url})`));
  }

  async #verifyApplied(request: MirrorClaim): Promise<void> {
    const current = await this.#readback(request.ticket);
    if (
      !sameSet(current.assignees, [request.owner]) ||
      !current.labeled ||
      current.state !== "open"
    )
      throw new AmbiguousTrackerResultError("GitHub claim mirror could not be verified");
  }

  async #readback(ticket: TicketRef): Promise<MirrorState> {
    try {
      return mirrorState(await this.#issue(issueAddress(ticket)));
    } catch (error) {
      throw new AmbiguousTrackerResultError(`GitHub mirror readback failed: ${String(error)}`);
    }
  }

  async #removeLabel(address: IssueAddress): Promise<void> {
    await this.#write(
      "DELETE",
      `${issuePath(address)}/labels/${encodeURIComponent(INTERLOCK_LABEL)}`,
      undefined,
      [404],
    );
  }

  async #normalize(issue: Issue): Promise<Ticket> {
    const repository = repositoryOfApiUrl(issue.repository_url);
    const ref = issueRef(repository, issue.number);
    const address = { repository, number: issue.number };
    const parent = await this.#parent(address);
    const blockers = await this.#pages(
      `${issuePath(address)}/dependencies/blocked_by`,
      issueSchema,
    );
    const blocked = await this.#pages(`${issuePath(address)}/dependencies/blocking`, issueSchema);
    const edge = (other: Issue) => issueRef(repositoryOfApiUrl(other.repository_url), other.number);
    const dependencies: Dependency[] = blockers.map((other) => ({
      blocking: edge(other),
      blocked: ref,
      kind: "blocks",
    }));
    const dependents: Dependency[] = blocked.map((other) => ({
      blocking: ref,
      blocked: edge(other),
      kind: "blocks",
    }));
    const current = mirrorState(issue);
    const assignee = current.assignees[0];
    return {
      ref,
      ...(parent
        ? { map: issueMapRef(repositoryOfApiUrl(parent.repository_url), parent.number) }
        : {}),
      kind: kindOf(issue.type?.name),
      title: issue.title,
      ...(issue.body ? { description: issue.body } : {}),
      state: issue.state,
      status:
        issue.state === "closed"
          ? CLOSED_STATUS
          : current.labeled
            ? this.#claimedStatus
            : OPEN_STATUS,
      ...(assignee ? { assignee: actorRefSchema.parse(assignee) } : {}),
      dependencies,
      dependents,
      metadata: {
        nativeKey: `${repository}#${issue.number}`,
        url: issue.html_url,
        version: issue.updated_at,
        versionSource: "github.updated_at",
      },
    };
  }

  async #issue(address: IssueAddress): Promise<Issue> {
    const issue = await this.#get(issuePath(address), issueSchema);
    if (issue.pull_request !== undefined)
      throw new Error(`${address.repository}#${address.number} is a pull request, not an issue`);
    return issue;
  }

  async #parent(address: IssueAddress): Promise<Issue | undefined> {
    const response = await this.#transport.request("GET", `${issuePath(address)}/parent`);
    if (response.status === 404) return undefined;
    return parsed(response, "read parent issue", issueSchema);
  }

  async #pages<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.#get(`${path}?per_page=${PAGE_SIZE}&page=${page}`, z.array(schema));
      items.push(...batch);
      if (batch.length < PAGE_SIZE) return items;
    }
  }

  async #get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return parsed(await this.#transport.request("GET", path), `GET ${path}`, schema);
  }

  async #write(
    method: string,
    path: string,
    fields?: GitHubFields,
    accepted: readonly number[] = [],
  ): Promise<void> {
    const response = await this.#transport.request(method, path, fields);
    if ((response.status < 200 || response.status >= 300) && !accepted.includes(response.status))
      throw new Error(`GitHub ${method} ${path} failed (${response.status})`);
  }
}

function parsed<T>(
  response: { status: number; body?: unknown },
  operation: string,
  schema: z.ZodType<T>,
): T {
  if (response.status !== 200) throw new Error(`GitHub ${operation} failed (${response.status})`);
  const result = schema.safeParse(response.body);
  if (!result.success) throw new Error(`Invalid GitHub ${operation} response`);
  return result.data;
}

function issuePath(address: IssueAddress): string {
  return `repos/${address.repository}/issues/${address.number}`;
}

function mirrorSnapshot(issue: Issue): z.infer<typeof mirrorSnapshotSchema> {
  const { state: _state, ...snapshot } = mirrorState(issue);
  return snapshot;
}

function mirrorState(issue: Issue): MirrorState {
  return {
    assignees: issue.assignees.map((assignee) => assignee.login).toSorted(),
    labeled: issue.labels.some(
      (label) => (typeof label === "string" ? label : label.name) === INTERLOCK_LABEL,
    ),
    state: issue.state,
  };
}

function originalMirror(request: MirrorRestore): z.infer<typeof mirrorSnapshotSchema> {
  const result = mirrorSnapshotSchema.safeParse(request.originalSnapshot.payload);
  if (!result.success) throw new Error("Invalid GitHub original mirror snapshot");
  return result.data;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function kindOf(name: string | undefined): TicketKind {
  const value = name?.toLowerCase();
  return value === "research" || value === "prototype" || value === "decision" ? value : "task";
}

export function githubOwner(transport: GitHubTransport): () => Promise<ActorRef> {
  return async () => {
    const response = await transport.request("GET", "user");
    if (response.status === 401)
      throw new Error("GitHub rejected the gh credentials (401); run gh auth login");
    return actorRefSchema.parse(
      parsed(response, "read user", z.object({ login: z.string() })).login,
    );
  };
}
