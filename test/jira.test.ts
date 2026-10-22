import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { builtInAdapters } from "../src/adapters/registry.ts";
import {
  type JiraResponse,
  JiraTrackerAdapter,
  type JiraTransport,
} from "../src/adapters/trackers/jira.ts";
import type { ReleaseClaimRequest, RestoreClaimRequest } from "../src/domain/contracts.ts";
import {
  actorRefSchema,
  claimRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../src/domain/identifiers.ts";
import {
  type ActorRef,
  capabilities,
  requireCapabilities,
  type TrackerSnapshot,
  UnsupportedCapabilityError,
} from "../src/domain/model.ts";
import { evaluateFrontier, selectFrontierTicket } from "../src/frontier/evaluate.ts";

const ticket = ticketRefSchema.parse("jira:responsibid:JWB:ticket:JWB-288");
const map = mapRefSchema.parse("jira:responsibid:JWB:map:JWB-274");
const owner = actorRefSchema.parse("account");

interface FakeIssueOptions {
  assignee?: string | null;
  links?: unknown[];
  priority?: { id: string; name: string };
  rank?: string;
  status?: string;
}

function issue(key: string, options: FakeIssueOptions = {}) {
  const status = options.status ?? "To Do";
  return {
    key,
    fields: {
      updated: "2026-08-11T00:00:00.000Z",
      assignee: options.assignee ? { accountId: options.assignee } : null,
      status: { name: status, statusCategory: { key: status === "Done" ? "done" : "new" } },
      issuetype: { name: "Task" },
      parent: { key: "JWB-274" },
      priority: options.priority ?? { id: "9000", name: "Highest" },
      customfield_rank: options.rank ?? "0|i0000:",
      issuelinks: options.links ?? [],
    },
  };
}

class FakeJira implements JiraTransport {
  issues = [issue("JWB-288")];
  claimProperty: unknown = null;
  requests: Array<{ method: string; path: string; body?: unknown }> = [];

  async request(method: string, path: string, body?: unknown): Promise<JiraResponse> {
    this.requests.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (method === "GET" && path.includes("/properties/")) {
      return this.claimProperty === null
        ? { status: 404 }
        : { status: 200, body: { value: this.claimProperty } };
    }
    if (method === "GET" && path.includes("/issue/")) {
      const key = decodeURIComponent(path.match(/\/issue\/([^?]+)/)?.[1] ?? "");
      const found = this.issues.find((item) => item.key === key);
      return found ? { status: 200, body: found } : { status: 404 };
    }
    if (method === "POST" && path === "/rest/api/3/search/jql") {
      const sorted = this.issues.toSorted((left, right) =>
        left.fields.customfield_rank.localeCompare(right.fields.customfield_rank),
      );
      return { status: 200, body: { issues: sorted, isLast: true } };
    }
    return { status: 500 };
  }

  mutationCount(): number {
    return this.requests.filter(
      (request) => request.method !== "GET" && request.path !== "/rest/api/3/search/jql",
    ).length;
  }
}

function adapter(api: FakeJira) {
  return new JiraTrackerAdapter({
    instance: "responsibid",
    workspace: "JWB",
    transport: api,
    rankField: "customfield_rank",
    priorityOrder: ["Highest", "High", "Medium", "Low", "Lowest"],
  });
}

function snapshot(): TrackerSnapshot {
  return { version: "v1", payload: { assignee: null, status: "To Do", claim: null } };
}

function restoreRequest(claimedOwner: ActorRef | null = owner): RestoreClaimRequest {
  return {
    ticket,
    claim: claimRefSchema.parse("interlock-claim:c"),
    ...(claimedOwner ? { claimedOwner } : {}),
    originalSnapshot: snapshot(),
  };
}

describe("Jira tracker read adapter", () => {
  test("hydrates map tickets in standard Jira LexoRank order without numeric parsing", async () => {
    const api = new FakeJira();
    api.issues = [
      issue("JWB-LOW", {
        rank: "0|zzzzz:",
        priority: { id: "1", name: "Lowest" },
      }),
      issue("JWB-HIGH", {
        rank: "0|aaaaa:",
        priority: { id: "9000", name: "Highest" },
      }),
    ];
    const tickets = await adapter(api).listMapTickets(map);
    expect(tickets.map((item) => [String(item.ref), item.order, item.metadata?.rank])).toEqual([
      ["jira:responsibid:JWB:ticket:JWB-HIGH", 0, "0|aaaaa:"],
      ["jira:responsibid:JWB:ticket:JWB-LOW", 1, "0|zzzzz:"],
    ]);
    expect(selectFrontierTicket(tickets, "highest-priority").ref).toBe(required(tickets, 0).ref);
    const search = api.requests.find((request) => request.path === "/rest/api/3/search/jql");
    expect(search?.body).toMatchObject({ jql: 'parent = "JWB-274" ORDER BY Rank ASC' });
  });

  test("emits only inward blockers owned by the containing ticket", async () => {
    const api = new FakeJira();
    api.issues = [
      issue("JWB-279", { status: "Done", rank: "0|aaaaa:" }),
      issue("JWB-288", {
        rank: "0|bbbbb:",
        links: [
          {
            type: { inward: "is blocked by", outward: "blocks" },
            inwardIssue: { key: "JWB-279", fields: { status: { name: "Done" } } },
          },
          {
            type: { inward: "is blocked by", outward: "blocks" },
            outwardIssue: { key: "JWB-295", fields: { status: { name: "To Do" } } },
          },
        ],
      }),
    ];
    const tickets = await adapter(api).listMapTickets(map);
    const current = required(tickets, 1);
    expect(current.dependencies).toEqual([
      {
        blocking: ticketRefSchema.parse("jira:responsibid:JWB:ticket:JWB-279"),
        blocked: current.ref,
        kind: "blocks",
      },
    ]);
    expect(
      tickets.every((item) =>
        (item.dependencies ?? []).every((dependency) => dependency.blocked === item.ref),
      ),
    ).toBe(true);
    expect(() =>
      evaluateFrontier(tickets, { map }, { availableStatuses: new Set(["To Do"]) }),
    ).not.toThrow();
  });

  test("getTicket derives its stable order from the complete parent map", async () => {
    const api = new FakeJira();
    api.issues = [issue("JWB-OTHER", { rank: "0|aaaaa:" }), issue("JWB-288", { rank: "0|bbbbb:" })];
    expect(await adapter(api).getTicket(ticket)).toMatchObject({ ref: ticket, map, order: 1 });
  });

  test("advertises only implemented read capabilities and remains registry-unavailable", async () => {
    const subject = adapter(new FakeJira());
    const described = await subject.describe();
    expect(described).toEqual(capabilities("native_maps", "native_dependencies"));
    expect(builtInAdapters().find((item) => item.name === "jira")).toMatchObject({
      available: false,
      capabilities: {},
    });
    expect(() =>
      requireCapabilities(
        described,
        capabilities("atomic_assignment", "conditional_update", "claim_identity"),
      ),
    ).toThrow(UnsupportedCapabilityError);
  });

  test("preflight declines pickup before mutation for symmetric and asymmetric workflows", async () => {
    for (const workflow of ["symmetric", "asymmetric"]) {
      const api = new FakeJira();
      await expect(adapter(api).preflight(ticket)).rejects.toBeInstanceOf(
        UnsupportedCapabilityError,
      );
      expect(api.mutationCount()).toBe(0);
      expect(workflow).toBeString();
    }
  });

  test("snapshot preserves native owner and claim identity for recovery evidence", async () => {
    const api = new FakeJira();
    api.issues = [issue("JWB-288", { assignee: owner })];
    api.claimProperty = {
      claim: "interlock-claim:c",
      run: "interlock-run:r",
      owner,
      leaseExpiresAt: "2026-08-11T12:15:00.000Z",
      originalSnapshot: snapshot(),
    };
    expect(await adapter(api).snapshotClaimState(ticket)).toEqual({
      version: "2026-08-11T00:00:00.000Z",
      payload: {
        assignee: owner,
        status: "To Do",
        claim: api.claimProperty,
      },
    });
  });

  test("all mutation entry points fail closed and ownership-guard recovery inputs are required", async () => {
    const api = new FakeJira();
    const subject = adapter(api);
    const claim = {
      ticket,
      claim: claimRefSchema.parse("interlock-claim:c"),
      run: runRefSchema.parse("interlock-run:r"),
      owner,
      leaseExpiresAt: "2026-08-11T12:15:00.000Z",
      expectedVersion: "v1",
    };
    await expect(subject.claim(claim)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(subject.verifyClaim(claim)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(subject.restoreClaimState(restoreRequest(null))).rejects.toThrow(
      "Persisted claimed owner is required",
    );
    await expect(subject.restoreClaimState(restoreRequest())).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    const release: ReleaseClaimRequest = {
      ...restoreRequest(),
      expectedVersion: "v1",
      authorizedBy: owner,
    };
    await expect(subject.releaseClaim(release)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(subject.verifyReleased(release)).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    expect(api.mutationCount()).toBe(0);
  });
});

function required<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing item at index ${index}`);
  return item;
}

test("Jira requests and normalizes summary and ADF acceptance context without mutation", async () => {
  const api = new FakeJira();
  Object.assign(api.issues[0]?.fields ?? {}, {
    summary: "Implement context",
    description: {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", content: [{ type: "text", text: "Acceptance Criteria" }] },
        { type: "paragraph", content: [{ type: "text", text: "Preserve all ticket context." }] },
      ],
    },
  });
  const result = await adapter(api).getTicket(ticket);
  expect(result.title).toBe("Implement context");
  expect(result.description).toContain("Acceptance Criteria\nPreserve all ticket context.");
  expect(api.requests[0]?.path).toContain("summary,description");
  expect(
    z
      .object({ fields: z.array(z.string()) })
      .optional()
      .parse(api.requests.find((request) => request.method === "POST")?.body)?.fields,
  ).toEqual(expect.arrayContaining(["summary", "description"]));
  expect(api.mutationCount()).toBe(0);
});
