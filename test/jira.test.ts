import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ABSENT_LOCK_VERSION, GitClaimLock } from "../src/adapters/claims/git-lock.ts";
import { builtInAdapters } from "../src/adapters/registry.ts";
import type { HttpRequest, HttpTransport } from "../src/adapters/trackers/http.ts";
import {
  type JiraResponse,
  JiraTrackerAdapter,
  type JiraTransport,
  jiraBasicAuthTransport,
} from "../src/adapters/trackers/jira.ts";
import { runConformance } from "../src/conformance/runner.ts";
import { trackerConformance } from "../src/conformance/tracker.ts";
import {
  ClaimCollisionError,
  type ClaimRequest,
  type ReleaseClaimRequest,
  type RestoreClaimRequest,
} from "../src/domain/contracts.ts";
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
import type { MirrorRestore } from "../src/domain/tracker.ts";
import { ClaimCoordinator } from "../src/execution/claims.ts";
import { evaluateFrontier, selectFrontierTicket } from "../src/frontier/evaluate.ts";
import {
  GIT_TEST_TIMEOUT_MS,
  type GitRemoteFixture,
  gitRemoteFixture,
} from "./fixtures/git-remote.ts";

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
  artifacts: string[] = [];
  requests: Array<{ method: string; path: string; body?: unknown }> = [];
  fail: (method: string, path: string) => number | undefined = () => undefined;

  async request(method: string, path: string, body?: unknown): Promise<JiraResponse> {
    this.requests.push({ method, path, ...(body === undefined ? {} : { body }) });
    const failure = this.fail(method, path);
    if (failure) return { status: failure };
    if (method === "POST" && path === "/rest/api/3/search/jql") {
      const sorted = this.issues.toSorted((left, right) =>
        left.fields.customfield_rank.localeCompare(right.fields.customfield_rank),
      );
      return { status: 200, body: { issues: sorted, isLast: true } };
    }
    const key = decodeURIComponent(path.match(/\/issue\/([^/?]+)/)?.[1] ?? "");
    const found = this.issues.find((item) => item.key === key);
    if (!found) return { status: 404 };
    if (path.endsWith("/remotelink") && method === "GET")
      return { status: 200, body: this.artifacts.map((url) => ({ object: { url } })) };
    if (path.includes("/properties/")) {
      if (method === "PUT") this.claimProperty = body;
      if (method === "DELETE") this.claimProperty = null;
      if (method !== "GET") return { status: 204 };
      return this.claimProperty === null
        ? { status: 404 }
        : { status: 200, body: { value: this.claimProperty } };
    }
    if (path.endsWith("/assignee") && method === "PUT") {
      const accountId = z.object({ accountId: z.string().nullable() }).parse(body).accountId;
      found.fields.assignee = accountId ? { accountId } : null;
      return { status: 204 };
    }
    if (path.endsWith("/transitions")) {
      if (method === "GET") return { status: 200, body: { transitions: TRANSITIONS } };
      const id = z.object({ transition: z.object({ id: z.string() }) }).parse(body).transition.id;
      const name = TRANSITIONS.find((item) => item.id === id)?.to.name ?? "";
      found.fields.status = { name, statusCategory: { key: "new" } };
      return { status: 204 };
    }
    if (method === "GET") return { status: 200, body: found };
    return { status: 500 };
  }

  mutationCount(): number {
    return this.requests.filter(
      (request) => request.method !== "GET" && request.path !== "/rest/api/3/search/jql",
    ).length;
  }

  mirror() {
    return {
      assignee: this.issues[0]?.fields.assignee?.accountId ?? null,
      status: this.issues[0]?.fields.status.name,
      claim: this.claimProperty,
    };
  }
}

const TRANSITIONS = [
  { id: "11", to: { name: "To Do" } },
  { id: "21", to: { name: "In Progress" } },
];

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

function restoreRequest(): MirrorRestore {
  return {
    ticket,
    claim: claimRefSchema.parse("interlock-claim:c"),
    claimedOwner: owner,
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
    const tickets = await adapter(api).list_work(map);
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
    const tickets = await adapter(api).list_work(map);
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

  test("read derives its stable order from the complete parent map", async () => {
    const api = new FakeJira();
    api.issues = [issue("JWB-OTHER", { rank: "0|aaaaa:" }), issue("JWB-288", { rank: "0|bbbbb:" })];
    expect((await adapter(api).read(ticket)).ticket).toMatchObject({ ref: ticket, map, order: 1 });
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

  test("read reads the ticket without mutation", async () => {
    const api = new FakeJira();
    await adapter(api).read(ticket);
    expect(api.mutationCount()).toBe(0);
  });

  test("snapshot preserves native owner and claim identity for recovery evidence", async () => {
    const api = new FakeJira();
    api.issues = [issue("JWB-288", { assignee: owner })];
    api.claimProperty = {
      claim: "interlock-claim:c",
      run: "interlock-run:r",
      owner,
    };
    expect((await adapter(api).read(ticket)).snapshot).toEqual({
      version: "2026-08-11T00:00:00.000Z",
      payload: {
        assignee: owner,
        status: "To Do",
        claim: api.claimProperty,
      },
    });
  });

  test("restoration requires the persisted owner; comments and resolution still fail closed", async () => {
    const api = new FakeJira();
    const subject = adapter(api);
    await expect(
      subject.restore(Object.assign(restoreRequest(), { claimedOwner: undefined })),
    ).rejects.toThrow("Persisted claimed owner is required");
    await expect(subject.addComment(ticket, "x")).rejects.toBeInstanceOf(
      UnsupportedCapabilityError,
    );
    await expect(subject.resolve(ticket)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(api.mutationCount()).toBe(0);
  });

  test("mirror writes the property first and restores it last, read back each time", async () => {
    const api = new FakeJira();
    const subject = adapter(api);
    const request = claimRequest(owner, "c", "v1");
    await subject.apply(request);
    await subject.verify({ ...request, state: "applied" });
    expect(api.requests.filter((item) => item.method !== "GET").map((item) => item.method)).toEqual(
      ["PUT", "PUT", "POST"],
    );
    expect(api.requests.find((item) => item.method === "PUT")?.path).toContain(
      "/properties/interlock.claim",
    );
    await subject.restore(restoreRequest());
    await subject.verify({ ...restoreRequest(), state: "restored" });
    const writes = api.requests.filter((item) => item.method !== "GET");
    expect(writes.at(-1)).toMatchObject({ method: "DELETE" });
    expect(api.mirror()).toEqual({ assignee: null, status: "To Do", claim: null });
  });

  test("mirror refuses tickets marked by another claim and human changes before restoring", async () => {
    const api = new FakeJira();
    const subject = adapter(api);
    api.issues = [issue("JWB-288", { assignee: "human" })];
    await expect(subject.apply(claimRequest(owner, "c", "v1"))).rejects.toBeInstanceOf(
      ClaimCollisionError,
    );
    expect(api.mutationCount()).toBe(0);

    api.issues = [issue("JWB-288")];
    await subject.apply(claimRequest(owner, "c", "v1"));
    const marked = api.mutationCount();
    reassign(api, "human");
    await expect(subject.restore(restoreRequest())).rejects.toThrow("changed outside Interlock");
    await expect(subject.verify({ ...restoreRequest(), state: "restored" })).rejects.toThrow(
      "Jira restored state could not be verified",
    );
    expect(api.mutationCount()).toBe(marked);
  });
});

let remotes: GitRemoteFixture[] = [];
afterEach(async () => {
  await Promise.all(remotes.map((fixture) => fixture.dispose()));
  remotes = [];
});

function reassign(api: FakeJira, accountId: string): void {
  const fields = api.issues[0]?.fields;
  if (!fields) throw new Error("Missing fake issue");
  fields.assignee = { accountId };
}

function claimRequest(claimOwner: ActorRef, id: string, expectedVersion: string): ClaimRequest {
  return {
    ticket,
    claim: claimRefSchema.parse(`interlock-claim:${id}`),
    run: runRefSchema.parse(`interlock-run:${id}`),
    owner: claimOwner,
    leaseExpiresAt: "2026-10-22T00:15:00.000Z",
    expectedVersion,
  };
}

async function lockedJira(api: FakeJira) {
  const fixture = await gitRemoteFixture();
  remotes.push(fixture);
  const locked = (repository: string) =>
    new ClaimCoordinator(
      new GitClaimLock({
        repository,
        remote: fixture.remote,
        clock: fixture.clock,
        git: fixture.git,
      }),
      adapter(api),
    );
  return { first: locked(fixture.alice), second: locked(fixture.bob) };
}

describe("Jira mirror behind the Git claim lock", () => {
  test(
    "only the claim lock advertises conditional ownership",
    async () => {
      const { first } = await lockedJira(new FakeJira());
      const described = await first.lock.describe();
      expect(described).toMatchObject(capabilities("conditional_update"));
      expect(described).not.toHaveProperty("atomic_assignment");
      expect(await adapter(new FakeJira()).describe()).not.toHaveProperty("conditional_update");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "claim -> verify -> renew -> release restores Jira and releases the lock",
    async () => {
      const api = new FakeJira();
      const { first } = await lockedJira(api);
      const original = await first.snapshotClaimState(ticket);
      expect(original.version).toBe(ABSENT_LOCK_VERSION);
      const request = claimRequest(owner, "c", original.version);
      await first.claim(request);
      await first.verifyClaim(request);
      expect(api.mirror()).toEqual({
        assignee: owner,
        status: "In Progress",
        claim: { claim: request.claim, run: request.run, owner },
      });
      const claimed = await first.snapshotClaimState(ticket);
      const renew = {
        claim: request.claim,
        ticket,
        leaseExpiresAt: "2026-10-22T00:30:00.000Z",
        expectedVersion: claimed.version,
      };
      await first.renewLease(renew);
      await first.verifyLease(renew);
      const renewed = await first.snapshotClaimState(ticket);
      const release: ReleaseClaimRequest = {
        ticket,
        claim: request.claim,
        claimedOwner: owner,
        originalSnapshot: original,
        expectedVersion: renewed.version,
        authorizedBy: owner,
      };
      await first.releaseClaim(release);
      await first.verifyReleased(release);
      expect(api.mirror()).toEqual({ assignee: null, status: "To Do", claim: null });
      const released = await first.snapshotClaimState(ticket);
      expect(released.payload).toMatchObject({ lock: { record: { action: "release" } } });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "a concurrent second claim is rejected before it writes to Jira",
    async () => {
      const api = new FakeJira();
      const { first, second } = await lockedJira(api);
      const results = await Promise.allSettled([
        first.claim(claimRequest(owner, "a", ABSENT_LOCK_VERSION)),
        second.claim(claimRequest(actorRefSchema.parse("other"), "b", ABSENT_LOCK_VERSION)),
      ]);
      const rejected = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toBeInstanceOf(ClaimCollisionError);
      const winner = results[0]?.status === "fulfilled" ? owner : "other";
      expect(
        api.requests.filter((item) => item.path.includes("/properties/") && item.method === "PUT"),
      ).toHaveLength(1);
      expect(api.mirror().assignee).toBe(winner);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "a mirror failure after the lock is held compensates Jira and the lock",
    async () => {
      const api = new FakeJira();
      const { first } = await lockedJira(api);
      const original = await first.snapshotClaimState(ticket);
      const request = claimRequest(owner, "c", original.version);
      api.fail = (method, path) =>
        method === "PUT" && path.endsWith("/assignee") ? 500 : undefined;
      const failure = first.claim(request);
      await expect(failure).rejects.toThrow("Jira assign issue failed (500)");
      await expect(failure).rejects.not.toBeInstanceOf(ClaimCollisionError);
      api.fail = () => undefined;
      const restore: RestoreClaimRequest = {
        ticket,
        claim: request.claim,
        claimedOwner: owner,
        originalSnapshot: original,
      };
      await first.restoreClaimState(restore);
      await first.verifyRestored(restore);
      expect(api.mirror()).toEqual({ assignee: null, status: "To Do", claim: null });
      expect((await first.snapshotClaimState(ticket)).payload).toMatchObject({
        lock: { record: { action: "release", claim: request.claim } },
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "a human assignment after the snapshot compensates by releasing the lock",
    async () => {
      const api = new FakeJira();
      const { first } = await lockedJira(api);
      const original = await first.snapshotClaimState(ticket);
      const request = claimRequest(owner, "c", original.version);
      reassign(api, "human");
      const failure = first.claim(request);
      await expect(failure).rejects.toThrow("Tracker mirror conflicts with the held claim lock");
      await expect(failure).rejects.not.toBeInstanceOf(ClaimCollisionError);
      const restore: RestoreClaimRequest = {
        ticket,
        claim: request.claim,
        claimedOwner: owner,
        originalSnapshot: original,
      };
      await first.restoreClaimState(restore);
      await first.verifyRestored(restore);
      expect(api.mirror()).toEqual({ assignee: "human", status: "To Do", claim: null });
      expect(api.mutationCount()).toBe(0);
      expect((await first.snapshotClaimState(ticket)).payload).toMatchObject({
        lock: { record: { action: "release", claim: request.claim } },
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    "release refuses a human Jira change and keeps the lock held",
    async () => {
      const api = new FakeJira();
      const { first } = await lockedJira(api);
      const original = await first.snapshotClaimState(ticket);
      const request = claimRequest(owner, "c", original.version);
      await first.claim(request);
      const claimed = await first.snapshotClaimState(ticket);
      reassign(api, "human");
      await expect(
        first.releaseClaim({
          ticket,
          claim: request.claim,
          claimedOwner: owner,
          originalSnapshot: original,
          expectedVersion: claimed.version,
          authorizedBy: owner,
        }),
      ).rejects.toThrow("changed outside Interlock");
      expect((await first.snapshotClaimState(ticket)).version).toBe(claimed.version);
    },
    GIT_TEST_TIMEOUT_MS,
  );
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
  const result = (await adapter(api).read(ticket)).ticket;
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

const jiraEnvironment = {
  JIRA_SITE: "responsibid.atlassian.net",
  JIRA_USER_EMAIL: "lane@example.com",
  JIRA_API_TOKEN: "token-value",
};

function recordingHttp(api: FakeJira, calls: Array<{ url: string; request: HttpRequest }>) {
  const http: HttpTransport = async (url, request = {}) => {
    calls.push({ url, request });
    const parsed = new URL(url);
    const response = await api.request(
      request.method ?? "GET",
      `${parsed.pathname}${parsed.search}`,
      request.body === undefined ? undefined : JSON.parse(request.body),
    );
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
    });
  };
  return http;
}

describe("Jira basic-auth transport", () => {
  test("authenticates from environment and hydrates summary and description into Ticket", async () => {
    const api = new FakeJira();
    Object.assign(api.issues[0]?.fields ?? {}, {
      summary: "Live summary",
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Live description" }] }],
      },
    });
    const calls: Array<{ url: string; request: HttpRequest }> = [];
    const subject = new JiraTrackerAdapter({
      instance: "responsibid",
      workspace: "JWB",
      transport: jiraBasicAuthTransport(jiraEnvironment, recordingHttp(api, calls)),
      rankField: "customfield_rank",
      priorityOrder: ["Highest", "High", "Medium", "Low", "Lowest"],
    });
    const result = (await subject.read(ticket)).ticket;
    expect(result).toMatchObject({ title: "Live summary", description: "Live description" });
    expect(new Set(calls.map((call) => new URL(call.url).origin))).toEqual(
      new Set(["https://responsibid.atlassian.net"]),
    );
    for (const call of calls)
      expect(call.request.headers).toMatchObject({
        Authorization: `Basic ${btoa("lane@example.com:token-value")}`,
        Accept: "application/json",
      });
    expect(calls[1]?.request).toMatchObject({ method: "POST" });
    expect(calls[1]?.request.headers?.["Content-Type"]).toBe("application/json");
    expect(api.mutationCount()).toBe(0);
  });

  test("names a missing variable without echoing any credential", () => {
    for (const name of Object.keys(jiraEnvironment)) {
      const environment = { ...jiraEnvironment, [name]: undefined };
      expect(() => jiraBasicAuthTransport(environment)).toThrow(`${name} is required for Jira`);
    }
    for (const site of [
      "http://responsibid.atlassian.net",
      "https://u:p@x.net",
      "https://x.net/a",
    ]) {
      let message = "";
      try {
        jiraBasicAuthTransport({ ...jiraEnvironment, JIRA_SITE: site });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("JIRA_SITE must be an https Jira site origin");
      expect(message).not.toContain("token-value");
    }
  });

  test("refuses non-REST paths and keeps status for non-JSON responses", async () => {
    const http: HttpTransport = async () => new Response("<html>gateway</html>", { status: 502 });
    const transport = jiraBasicAuthTransport(jiraEnvironment, http);
    await expect(transport.request("GET", "//evil.example/rest")).rejects.toThrow(
      "Jira request path must be a REST path",
    );
    expect(await transport.request("GET", "/rest/api/3/myself")).toEqual({ status: 502 });
  });
});

test("Jira satisfies portable tracker conformance through its injected transport", async () => {
  const report = await runConformance(
    trackerConformance(async () => {
      const api = new FakeJira();
      const subject = adapter(api);
      const claim = {
        ticket,
        claim: "interlock-claim:conformance" as const,
        run: "interlock-run:conformance" as const,
        owner,
      };
      return {
        adapter: subject,
        claim,
        otherOwner: actorRefSchema.parse("other-human"),
        async observe() {
          const raw = required(api.issues, 0);
          const fields = raw.fields;
          const mirror = z
            .object({
              claim: claimRefSchema,
              run: runRefSchema,
              owner: actorRefSchema,
              supersedes: claimRefSchema.optional(),
            })
            .nullable()
            .parse(api.claimProperty);
          return {
            ticket: {
              ref: ticket,
              map,
              kind: "task" as const,
              state: "open" as const,
              status: fields.status.name,
              order: 0,
              ...(fields.assignee
                ? { assignee: actorRefSchema.parse(fields.assignee.accountId) }
                : {}),
            },
            mirror: mirror
              ? {
                  ticket,
                  claim: mirror.claim,
                  run: mirror.run,
                  owner: mirror.owner,
                  ...(mirror.supersedes ? { supersedes: mirror.supersedes } : {}),
                }
              : null,
            artifacts: [...api.artifacts],
            writes: api.mutationCount(),
          };
        },
        changeOwner: async (owner) => reassign(api, owner),
        addArtifact: async (url) => {
          api.artifacts.push(url);
        },
        loseWriteReadback() {
          const before = api.mutationCount();
          api.fail = (method) =>
            method === "GET" && api.mutationCount() > before ? 503 : undefined;
        },
      };
    }),
  );
  expect(report.results.filter((result) => !result.ok)).toEqual([]);
  expect(report.ok).toBe(true);
});

test.each(["status", "assignee"])(
  "unverified %s restoration retains the claim property and held Git lock",
  async (field) => {
    const api = new FakeJira();
    const { first } = await lockedJira(api);
    const original = await first.snapshotClaimState(ticket);
    const request = claimRequest(owner, "guarded", original.version);
    await first.claim(request);
    const held = await first.lock.read(ticket);
    api.fail = (method, path) =>
      field === "status"
        ? method === "POST" && path.endsWith("/transitions")
          ? 204
          : undefined
        : method === "PUT" && path.endsWith("/assignee")
          ? 204
          : undefined;
    await expect(
      first.releaseClaim({
        ...request,
        claimedOwner: owner,
        originalSnapshot: original,
        expectedVersion: held.version,
        authorizedBy: owner,
      }),
    ).rejects.toThrow("was not verified");
    expect(await first.lock.read(ticket)).toEqual(held);
    expect(api.claimProperty).toMatchObject({ claim: request.claim });
  },
  GIT_TEST_TIMEOUT_MS,
);

test(
  "compensation keeps ownership until restoration verification succeeds",
  async () => {
    const api = new FakeJira();
    const { first } = await lockedJira(api);
    const original = await first.snapshotClaimState(ticket);
    const request = claimRequest(owner, "compensation", original.version);
    await first.claim(request);
    const held = await first.lock.read(ticket);
    first.tracker.restore = async () => {};
    await expect(
      first.restoreClaimState({ ...request, claimedOwner: owner, originalSnapshot: original }),
    ).rejects.toThrow("Jira restored state could not be verified");
    expect(await first.lock.read(ticket)).toEqual(held);
  },
  GIT_TEST_TIMEOUT_MS,
);
