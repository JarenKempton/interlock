import { describe, expect, test } from "bun:test";
import { builtInAdapters } from "../src/adapters/registry.ts";
import {
  GitHubIssuesTrackerAdapter,
  GitHubWorkspaceBoundaryError,
} from "../src/adapters/trackers/github.ts";
import type { HttpResponse, HttpTransport } from "../src/adapters/trackers/http.ts";
import { LinearTrackerAdapter } from "../src/adapters/trackers/linear.ts";
import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
  type ReleaseClaimRequest,
} from "../src/domain/contracts.ts";
import {
  actorRefSchema,
  claimRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../src/domain/identifiers.ts";
import { evaluateFrontier, reconcileDependencyStatuses } from "../src/frontier/evaluate.ts";

function response(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): HttpResponse {
  return {
    status: options.status ?? 200,
    headers: new Headers(options.headers),
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

interface RecordedRequest {
  url: string;
  body?: string;
  headers?: Record<string, string>;
}

function queueTransport(items: HttpResponse[], requests: RecordedRequest[] = []): HttpTransport {
  return async (url, request) => {
    requests.push({
      url,
      ...(request?.body ? { body: request.body } : {}),
      ...(request?.headers ? { headers: request.headers } : {}),
    });
    const item = items.shift();
    if (!item) throw new Error(`Unexpected request: ${url}`);
    return item;
  };
}

const linearIssue = (
  id: string,
  options: {
    completed?: boolean;
    inverseRelations?: unknown[];
    labelsHaveNextPage?: boolean;
    relationsHaveNextPage?: boolean;
  } = {},
) => ({
  id,
  identifier: `WAY-${id}`,
  title: `Linear ${id}`,
  description: "## Acceptance criteria\nRetain Linear context.",
  updatedAt: "2026-08-11T00:00:00.000Z",
  completedAt: options.completed ? "2026-08-11T00:00:00.000Z" : null,
  canceledAt: null,
  parent: { id: "map" },
  assignee: null,
  state: { name: "Todo" },
  labels: {
    nodes: [{ name: "wayfinder:task" }],
    pageInfo: {
      hasNextPage: options.labelsHaveNextPage ?? false,
      endCursor: options.labelsHaveNextPage ? "next" : null,
    },
  },
  inverseRelations: {
    nodes: options.inverseRelations ?? [],
    pageInfo: {
      hasNextPage: options.relationsHaveNextPage ?? false,
      endCursor: options.relationsHaveNextPage ? "next" : null,
    },
  },
});

const githubIssue = (
  number: number,
  assignees: Array<{ login: string }> = [],
  repository = "o/r",
) => ({
  number,
  title: `GitHub ${number}`,
  body: "## Acceptance criteria\nRetain GitHub context.",
  state: "open",
  updated_at: `2026-08-11T00:00:0${number}.000Z`,
  html_url: `https://github.test/${repository}/issues/${number}`,
  repository_url: `https://api.github.test/repos/${repository}`,
  labels: [{ name: "wayfinder:task" }],
  assignees,
});

describe("Linear tracker adapter", () => {
  test("exhausts cursor pages and preserves map order", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = new LinearTrackerAdapter({
      token: "secret",
      pageSize: 1,
      transport: queueTransport(
        [
          response({
            data: {
              issue: {
                children: {
                  nodes: [linearIssue("1")],
                  pageInfo: { hasNextPage: true, endCursor: "next" },
                },
              },
            },
          }),
          response({
            data: {
              issue: {
                children: {
                  nodes: [linearIssue("2")],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
        ],
        requests,
      ),
    });
    const tickets = await adapter.listMapTickets(mapRefSchema.parse("linear:api:team:map:map"));
    expect(tickets[0]).toMatchObject({
      title: "Linear 1",
      description: "## Acceptance criteria\nRetain Linear context.",
    });
    expect(tickets.map((ticket) => [String(ticket.ref), ticket.order])).toEqual([
      ["linear:api:team:ticket:1", 0],
      ["linear:api:team:ticket:2", 1],
    ]);
    expect(JSON.parse(requestBody(requests, 1)).variables.after).toBe("next");
  });

  test("rejects GraphQL errors even when HTTP succeeds", async () => {
    const adapter = new LinearTrackerAdapter({
      token: "secret",
      transport: queueTransport([
        response({ data: { issue: linearIssue("1") }, errors: [{ message: "partial failure" }] }),
      ]),
    });
    await expect(
      adapter.getTicket(ticketRefSchema.parse("linear:api:team:ticket:1")),
    ).rejects.toThrow("partial failure");
  });

  test("uses the issue side of inverse blocks relations and unblocks after closure", async () => {
    const blocker = linearIssue("1");
    const blocked = linearIssue("2", {
      inverseRelations: [{ type: "blocks", issue: { id: "1" } }],
    });
    const adapter = new LinearTrackerAdapter({
      token: "secret",
      transport: queueTransport([
        response({
          data: {
            issue: {
              children: {
                nodes: [blocker, blocked],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      ]),
    });
    const tickets = await adapter.listMapTickets(mapRefSchema.parse("linear:api:team:map:map"));
    expect(String(tickets[1]?.dependencies?.[0]?.blocking)).toBe("linear:api:team:ticket:1");
    expect(
      reconcileDependencyStatuses(
        tickets,
        {},
        {
          ready: "Todo",
          blocked: "Blocked",
          managedStatuses: new Set(["Todo", "Blocked"]),
        },
      ).transitions[0],
    ).toMatchObject({ ticket: tickets[1]?.ref, expectedVersion: blocked.updatedAt });
    const withoutToken = tickets.map((ticket, index) =>
      index === 1 ? { ...ticket, metadata: { versionSource: "missing-provider-token" } } : ticket,
    );
    expect(() =>
      reconcileDependencyStatuses(
        withoutToken,
        {},
        {
          ready: "Todo",
          blocked: "Blocked",
          managedStatuses: new Set(["Todo", "Blocked"]),
        },
      ),
    ).toThrow("lacks a tracker version guard");
    expect(evaluateFrontier(tickets, {}, { availableStatuses: new Set(["Todo"]) })).toEqual([
      required(tickets, 0),
    ]);
    const closedBlocker = { ...required(tickets, 0), state: "closed" as const, status: "Done" };
    expect(
      evaluateFrontier(
        [closedBlocker, required(tickets, 1)],
        {},
        {
          availableStatuses: new Set(["Todo"]),
        },
      ).map((ticket) => String(ticket.ref)),
    ).toEqual(["linear:api:team:ticket:2"]);
  });

  test("exhausts nested Linear label and inverse-relation pages", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = new LinearTrackerAdapter({
      token: "secret",
      pageSize: 1,
      transport: queueTransport(
        [
          response({
            data: {
              issue: linearIssue("1", {
                labelsHaveNextPage: true,
                relationsHaveNextPage: true,
              }),
            },
          }),
          response({
            data: {
              issue: {
                labels: {
                  nodes: [{ name: "triage" }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
          response({
            data: {
              issue: {
                inverseRelations: {
                  nodes: [{ type: "blocks", issue: { id: "blocker" } }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
        ],
        requests,
      ),
    });
    const ticket = await adapter.getTicket(ticketRefSchema.parse("linear:api:team:ticket:1"));
    expect(String(ticket.dependencies?.[0]?.blocking)).toBe("linear:api:team:ticket:blocker");
    expect(requests).toHaveLength(3);
    expect(JSON.parse(requestBody(requests, 1)).variables.after).toBe("next");
    expect(JSON.parse(requestBody(requests, 2)).variables.after).toBe("next");
  });
});

describe("GitHub Issues tracker adapter", () => {
  test("follows Link pagination, filters pull requests, and hydrates blockers", async () => {
    const adapter = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      pageSize: 1,
      transport: queueTransport([
        response([githubIssue(1)], {
          headers: { link: '<https://api.github.test/page2>; rel="next"' },
        }),
        response([{ ...githubIssue(99), pull_request: {} }, githubIssue(2)]),
        response([githubIssue(2)]),
        response([]),
      ]),
    });
    const tickets = await adapter.listMapTickets(mapRefSchema.parse("github:github.com:o/r:map:5"));
    expect(tickets[0]).toMatchObject({
      title: "GitHub 1",
      description: "## Acceptance criteria\nRetain GitHub context.",
    });
    expect(tickets.map((ticket) => String(ticket.ref))).toEqual([
      "github:github.com:o/r:ticket:1",
      "github:github.com:o/r:ticket:2",
    ]);
    expect(String(tickets[0]?.dependencies?.[0]?.blocking)).toBe("github:github.com:o/r:ticket:2");
    expect(tickets[1]?.order).toBe(2);
    expect(
      reconcileDependencyStatuses(
        tickets,
        {},
        {
          ready: "open",
          blocked: "blocked",
          managedStatuses: new Set(["open", "blocked"]),
        },
      ).transitions[0],
    ).toMatchObject({ ticket: tickets[0]?.ref, expectedVersion: githubIssue(1).updated_at });
  });

  test("rejects cross-repository children and blockers at the v1 workspace boundary", async () => {
    const childAdapter = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([response([githubIssue(7, [], "child/repo")])]),
    });
    await expect(
      childAdapter.listMapTickets(mapRefSchema.parse("github:github.com:parent/repo:map:5")),
    ).rejects.toBeInstanceOf(GitHubWorkspaceBoundaryError);

    const blockerAdapter = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([
        response([githubIssue(7, [], "parent/repo")]),
        response([githubIssue(8, [], "blocker/repo")]),
      ]),
    });
    try {
      await blockerAdapter.listMapTickets(
        mapRefSchema.parse("github:github.com:parent/repo:map:5"),
      );
      throw new Error("Expected a workspace boundary failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubWorkspaceBoundaryError);
      expect(error).toMatchObject({
        code: "cross_workspace_reference",
        expectedWorkspace: "parent/repo",
        actualWorkspace: "blocker/repo",
        entity: "ticket",
      });
    }
  });

  test("uses the documented GitHub API version and endpoint paths", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([response([githubIssue(7)]), response([])], requests),
    });
    await adapter.listMapTickets(mapRefSchema.parse("github:github.com:o/r:map:5"));
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/repos/o/r/issues/5/sub_issues",
      "/repos/o/r/issues/7/dependencies/blocked_by",
    ]);
    for (const request of requests) {
      expect(request.headers?.["X-GitHub-Api-Version"]).toBe("2026-03-10");
      expect(request.headers?.["User-Agent"]).toBe("interlock");
    }
  });

  test("rejects cross-origin pagination before sending authorization", async () => {
    const requests: RecordedRequest[] = [];
    const adapter = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport(
        [response([], { headers: { link: '<https://evil.test/steal>; rel="next"' } })],
        requests,
      ),
    });
    await expect(
      adapter.listMapTickets(mapRefSchema.parse("github:github.com:o/r:map:5")),
    ).rejects.toThrow("outside the configured API origin");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers?.Authorization).toBe("Bearer secret");
  });

  test("getTicket and map listing use the same map and assignee normalization", async () => {
    const issue = githubIssue(7, [{ login: "human" }], "child/repo");
    const parent = githubIssue(5, [], "child/repo");
    const direct = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([response(issue), response(parent), response([])]),
    });
    const listed = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([response([issue]), response([])]),
    });
    const directTicket = await direct.getTicket(
      ticketRefSchema.parse("github:github.com:child/repo:ticket:7"),
    );
    const listedTickets = await listed.listMapTickets(
      mapRefSchema.parse("github:github.com:child/repo:map:5"),
    );
    expect(directTicket).toEqual(required(listedTickets, 0));
  });

  test("rejects multiple assignees consistently for direct and map reads", async () => {
    const issue = githubIssue(7, [{ login: "one" }, { login: "two" }], "o/r");
    const direct = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([response(issue), response(githubIssue(5)), response([])]),
    });
    const listed = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([response([issue]), response([])]),
    });
    await expect(
      direct.getTicket(ticketRefSchema.parse("github:github.com:o/r:ticket:7")),
    ).rejects.toThrow("multiple assignees");
    await expect(
      listed.listMapTickets(mapRefSchema.parse("github:github.com:o/r:map:5")),
    ).rejects.toThrow("multiple assignees");
  });

  test("classifies a pre-write assignment race as a collision", async () => {
    const adapter = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([
        response(githubIssue(1, [{ login: "other" }]), { headers: { etag: "v2" } }),
      ]),
    });
    await expect(adapter.claim(claimRequest())).rejects.toBeInstanceOf(ClaimCollisionError);
  });

  test("restores from a fresh adapter while the persisted claimed owner is still present", async () => {
    const requests: RecordedRequest[] = [];
    const first = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([
        response(githubIssue(1), { headers: { etag: "v1" } }),
        response(githubIssue(1, [{ login: "human" }])),
      ]),
    });
    const request = claimRequest();
    await first.claim(request);
    const fresh = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport(
        [
          response(githubIssue(1, [{ login: "human" }])),
          response(githubIssue(1)),
          response(githubIssue(1), { headers: { etag: "v3" } }),
        ],
        requests,
      ),
    });
    const originalSnapshot = { version: "v1", payload: { assignee: null } };
    await fresh.restoreClaimState({
      ticket: request.ticket,
      claim: request.claim,
      claimedOwner: request.owner,
      originalSnapshot,
    });
    await fresh.verifyRestored({
      ticket: request.ticket,
      claim: request.claim,
      claimedOwner: request.owner,
      originalSnapshot,
    });
    expect(JSON.parse(requestBody(requests, 1))).toEqual({ assignees: [] });
  });

  test("a fresh adapter refuses to overwrite a concurrent owner during restoration", async () => {
    const fresh = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([
        response(githubIssue(1, [{ login: "other" }]), { headers: { etag: "v2" } }),
      ]),
    });
    const request = claimRequest();
    await expect(
      fresh.restoreClaimState({
        ticket: request.ticket,
        claim: request.claim,
        claimedOwner: request.owner,
        originalSnapshot: { version: "v1", payload: { assignee: null } },
      }),
    ).rejects.toBeInstanceOf(ClaimCollisionError);
  });

  test("can compensate a claim whose write response was ambiguous", async () => {
    const adapter = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([
        response(githubIssue(1), { headers: { etag: "v1" } }),
        response({ message: "gateway lost response" }, { status: 500 }),
        response(githubIssue(1, [{ login: "human" }])),
        response(githubIssue(1)),
        response(githubIssue(1), { headers: { etag: "v3" } }),
      ]),
    });
    const request = claimRequest();
    await expect(adapter.claim(request)).rejects.toBeInstanceOf(AmbiguousTrackerResultError);
    const originalSnapshot = { version: "v1", payload: { assignee: null } };
    await adapter.restoreClaimState({
      ticket: request.ticket,
      claim: request.claim,
      claimedOwner: request.owner,
      originalSnapshot,
    });
    await adapter.verifyRestored({
      ticket: request.ticket,
      claim: request.claim,
      claimedOwner: request.owner,
      originalSnapshot,
    });
  });

  test("release enforces authorization, expected version, and persisted owner", async () => {
    const base = releaseRequest();
    const unauthorized = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([]),
    });
    await expect(
      Reflect.apply(unauthorized.releaseClaim, unauthorized, [{ ...base, authorizedBy: "" }]),
    ).rejects.toThrow("authorizing actor");

    const stale = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([
        response(githubIssue(1, [{ login: "human" }]), { headers: { etag: "v3" } }),
      ]),
    });
    await expect(stale.releaseClaim(base)).rejects.toBeInstanceOf(ClaimCollisionError);

    const fresh = new GitHubIssuesTrackerAdapter({
      token: "secret",
      apiBase: "https://api.github.test",
      transport: queueTransport([
        response(githubIssue(1, [{ login: "human" }]), { headers: { etag: "v2" } }),
        response(githubIssue(1)),
        response(githubIssue(1), { headers: { etag: "v3" } }),
      ]),
    });
    await fresh.releaseClaim(base);
    await fresh.verifyReleased(base);
  });
});

test("registry does not advertise uncomposed tracker adapters as available", () => {
  const trackers = builtInAdapters().filter((adapter) => adapter.kind === "tracker");
  expect(trackers.map(({ name, available }) => ({ name, available }))).toEqual([
    { name: "github", available: false },
    { name: "jira", available: false },
    { name: "linear", available: false },
    { name: "markdown", available: false },
  ]);
});

function claimRequest(): ClaimRequest {
  return {
    claim: claimRefSchema.parse("interlock-claim:test"),
    run: runRefSchema.parse("interlock-run:test"),
    ticket: ticketRefSchema.parse("github:github.com:o/r:ticket:1"),
    owner: actorRefSchema.parse("human"),
    leaseExpiresAt: "2026-08-11T00:15:00.000Z",
    expectedVersion: "v1",
  };
}

function releaseRequest(): ReleaseClaimRequest {
  return {
    claim: claimRefSchema.parse("interlock-claim:test"),
    ticket: ticketRefSchema.parse("github:github.com:o/r:ticket:1"),
    claimedOwner: actorRefSchema.parse("human"),
    originalSnapshot: { version: "v1", payload: { assignee: null } },
    expectedVersion: "v2",
    authorizedBy: actorRefSchema.parse("operator"),
  };
}

function requestBody(requests: RecordedRequest[], index: number): string {
  const body = requests[index]?.body;
  if (body === undefined) throw new Error(`Request ${index} has no body`);
  return body;
}

function required<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing item ${index}`);
  return value;
}
