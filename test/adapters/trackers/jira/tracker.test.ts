import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ABSENT_LOCK_VERSION, GitClaimLock } from "../../../../src/adapters/git/claim-lock.ts";
import type { HttpRequest, HttpTransport } from "../../../../src/adapters/trackers/http.ts";
import {
  type JiraResponse,
  JiraTrackerAdapter,
  type JiraTrackerOptions,
  type JiraTransport,
  jiraBasicAuthTransport,
  jiraOrigin,
} from "../../../../src/adapters/trackers/jira/tracker.ts";
import { runConformance } from "../../../../src/conformance/runner.ts";
import { trackerConformance } from "../../../../src/conformance/tracker.ts";
import { normalizeClaimHome } from "../../../../src/domain/claim/home.ts";
import {
  AmbiguousTrackerResultError,
  ArtifactLinkConflictError,
  ClaimCollisionError,
  type ClaimRequest,
  type ReleaseClaimRequest,
  type RestoreClaimRequest,
} from "../../../../src/domain/contracts.ts";
import {
  actorRefSchema,
  claimRefSchema,
  mapRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../../../../src/domain/refs/identifiers.ts";
import type { ActorRef, TrackerSnapshot } from "../../../../src/domain/model.ts";
import type { MirrorRestore } from "../../../../src/domain/tracker/port.ts";
import { ClaimCoordinator } from "../../../../src/execution/claim/coordinator.ts";
import {
  GIT_TEST_TIMEOUT_MS,
  type GitRemoteFixture,
  gitRemoteFixture,
} from "../../../fixtures/git/remote.ts";
import { expectRejection } from "../../../fixtures/assertions/rejection.ts";

const ticket = ticketRefSchema.parse("jira:responsibid:JWB:ticket:JWB-288");
const map = mapRefSchema.parse("jira:responsibid:JWB:map:JWB-274");
const owner = actorRefSchema.parse("account");

interface FakeIssueOptions {
  assignee?: string | null;
  links?: unknown[];
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
      customfield_rank: options.rank ?? "0|i0000:",
      issuelinks: options.links ?? [],
    },
  };
}

class FakeJira implements JiraTransport {
  issues = [issue("JWB-288")];
  claimProperty: unknown = null;
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

function adapter(api: FakeJira, validateClaim?: JiraTrackerOptions["validateClaim"]) {
  return new JiraTrackerAdapter({
    instance: "responsibid",
    namespace: "JWB",
    transport: api,
    ...(validateClaim ? { validateClaim } : {}),
    claimHome: "github.com/jarenkempton/interlock",
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

describe("completion mirror removal", () => {
  const request = {
    ticket,
    claim: claimRefSchema.parse("interlock-claim:c"),
    run: runRefSchema.parse("interlock-run:r"),
    owner,
  };
  const property = { ...request, home: "github.com/jarenkempton/interlock", version: 2 };

  test("deletes only the property after identity comparison and verifies absence", async () => {
    const api = new FakeJira();
    api.issues = [issue("JWB-288", { status: "Done", assignee: owner })];
    api.claimProperty = property;
    await adapter(api).removeMirror(request);
    expect(api.mirror()).toEqual({ status: "Done", assignee: owner, claim: null });
    expect(api.requests.map(({ method }) => method)).toEqual(["GET", "DELETE", "GET"]);
    await adapter(api).removeMirror(request);
    expect(api.mutationCount()).toBe(1);
  });

  for (const field of ["claim", "run", "owner", "home"] as const) {
    test(`replacement ${field} refuses without mutation`, async () => {
      const api = new FakeJira();
      api.claimProperty = { ...property, [field]: "replacement" };
      await expectRejection(adapter(api).removeMirror(request)).toBeInstanceOf(ClaimCollisionError);
      expect(api.mutationCount()).toBe(0);
    });
  }

  test("successful DELETE with a surviving property fails verification", async () => {
    const api = new FakeJira();
    api.claimProperty = property;
    api.fail = (method) => (method === "DELETE" ? 204 : undefined);
    await expectRejection(adapter(api).removeMirror(request)).toBeInstanceOf(
      AmbiguousTrackerResultError,
    );
  });

  test("ambiguous DELETE stays journaled until readback proves removal", async () => {
    const api = new FakeJira();
    api.claimProperty = property;
    let completed = 0;
    const pending: unknown[] = [];
    const tracker = new JiraTrackerAdapter({
      instance: "responsibid",
      namespace: "JWB",
      transport: api,
      claimHome: property.home,
      journalWrite: (intent) => {
        pending.push(intent);
        return () => {
          completed += 1;
        };
      },
    });
    api.fail = (method) => (method === "DELETE" ? 503 : undefined);
    await expectRejection(tracker.removeMirror(request)).toBeInstanceOf(
      AmbiguousTrackerResultError,
    );
    expect(pending).toMatchObject([
      { operation: "remove claim mirror", expected: { field: "claim", value: null } },
    ]);
    expect(completed).toBe(0);
    await expectRejection(tracker.removeMirror(request)).toBeInstanceOf(
      AmbiguousTrackerResultError,
    );
    api.claimProperty = null;
    await tracker.removeMirror(request);
    expect(completed).toBe(1);
    expect(api.mutationCount()).toBe(1);
  });
});

describe("Jira tracker read adapter", () => {
  test("lists map tickets in the order Jira's search returns them", async () => {
    const api = new FakeJira();
    api.issues = [issue("JWB-LOW", { rank: "0|zzzzz:" }), issue("JWB-HIGH", { rank: "0|aaaaa:" })];
    const tickets = await adapter(api).listWork(map);
    expect(tickets.map((item) => String(item.ref))).toEqual([
      "jira:responsibid:JWB:ticket:JWB-HIGH",
      "jira:responsibid:JWB:ticket:JWB-LOW",
    ]);
    expect(tickets.every((item) => !("order" in item))).toBe(true);
    const search = api.requests.find((request) => request.path === "/rest/api/3/search/jql");
    expect(search?.body).toMatchObject({ jql: 'parent = "JWB-274" ORDER BY Rank ASC' });
  });

  test("emits inward blockers as dependencies and outward blocks as dependents", async () => {
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
          {
            type: { inward: "relates to", outward: "relates to" },
            inwardIssue: { key: "JWB-296", fields: { status: { name: "To Do" } } },
          },
          {
            type: { inward: "relates to", outward: "relates to" },
            outwardIssue: { key: "JWB-297", fields: { status: { name: "To Do" } } },
          },
        ],
      }),
    ];
    const tickets = await adapter(api).listWork(map);
    const current = required(tickets, 1);
    expect(current.dependencies).toEqual([
      {
        blocking: ticketRefSchema.parse("jira:responsibid:JWB:ticket:JWB-279"),
        blocked: current.ref,
        kind: "blocks",
      },
    ]);
    expect(current.dependents).toEqual([
      {
        blocking: current.ref,
        blocked: ticketRefSchema.parse("jira:responsibid:JWB:ticket:JWB-295"),
        kind: "blocks",
      },
    ]);
    expect(
      tickets.every(
        (item) =>
          (item.dependencies ?? []).every((dependency) => dependency.blocked === item.ref) &&
          (item.dependents ?? []).every((dependent) => dependent.blocking === item.ref),
      ),
    ).toBe(true);
  });

  test("read reads one issue and never searches its map", async () => {
    const api = new FakeJira();
    api.issues = [issue("JWB-OTHER", { rank: "0|aaaaa:" }), issue("JWB-288", { rank: "0|bbbbb:" })];
    expect((await adapter(api).read(ticket)).ticket).toMatchObject({ ref: ticket, map });
    expect(api.requests.some((request) => request.path === "/rest/api/3/search/jql")).toBe(false);
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
      home: "github.com/jarenkempton/interlock",
      version: 2,
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

  test("restoration requires the persisted owner", async () => {
    const api = new FakeJira();
    const subject = adapter(api);
    await expectRejection(
      subject.restore(Object.assign(restoreRequest(), { claimedOwner: undefined })),
    ).toThrow("Persisted claimed owner is required");
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
    await expectRejection(subject.apply(claimRequest(owner, "c", "v1"))).toBeInstanceOf(
      ClaimCollisionError,
    );
    expect(api.mutationCount()).toBe(0);

    api.issues = [issue("JWB-288")];
    await subject.apply(claimRequest(owner, "c", "v1"));
    const marked = api.mutationCount();
    reassign(api, "human");
    await expectRejection(subject.restore(restoreRequest())).toThrow("changed outside Interlock");
    await expectRejection(subject.verify({ ...restoreRequest(), state: "restored" })).toThrow(
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

async function lockedJira(api: FakeJira, firstTracker = adapter(api)) {
  const fixture = await gitRemoteFixture();
  remotes.push(fixture);
  const locked = (repository: string, tracker = adapter(api)) =>
    new ClaimCoordinator(
      new GitClaimLock({
        repository,
        home: normalizeClaimHome(fixture.remote),
        clock: fixture.clock,
        git: fixture.git,
      }),
      tracker,
    );
  return {
    first: locked(fixture.alice, firstTracker),
    second: locked(fixture.bob),
    clock: fixture.clock,
  };
}

describe("Jira mirror behind the Git claim lock", () => {
  test(
    "claim -> verify -> release restores Jira and releases the lock",
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
        claim: {
          claim: request.claim,
          run: request.run,
          owner,
          home: "github.com/jarenkempton/interlock",
          version: 2,
        },
      });
      const claimed = await first.snapshotClaimState(ticket);
      const release: ReleaseClaimRequest = {
        ticket,
        claim: request.claim,
        claimedOwner: owner,
        originalSnapshot: original,
        expectedVersion: claimed.version,
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
    "a definite mirror rejection after the lock is held compensates Jira and the lock",
    async () => {
      const api = new FakeJira();
      const { first } = await lockedJira(api);
      const original = await first.snapshotClaimState(ticket);
      const request = claimRequest(owner, "c", original.version);
      api.fail = (method, path) =>
        method === "PUT" && path.endsWith("/assignee") ? 403 : undefined;
      const failure = first.claim(request);
      await expectRejection(failure).toThrow("Jira assign issue failed (403)");
      await expectRejection(failure).not.toBeInstanceOf(ClaimCollisionError);
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
      await expectRejection(failure).toThrow("Tracker mirror conflicts with the held claim lock");
      await expectRejection(failure).not.toBeInstanceOf(ClaimCollisionError);
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
      await expectRejection(
        first.releaseClaim({
          ticket,
          claim: request.claim,
          claimedOwner: owner,
          originalSnapshot: original,
          expectedVersion: claimed.version,
          authorizedBy: owner,
        }),
      ).toThrow("changed outside Interlock");
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
  expect(api.mutationCount()).toBe(0);
});

const jiraCredentials = {
  site: "responsibid.atlassian.net",
  email: "lane@example.com",
  token: "token-value",
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
  test("authenticates with explicit credentials and hydrates summary and description into Ticket", async () => {
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
      namespace: "JWB",
      transport: jiraBasicAuthTransport(jiraCredentials, recordingHttp(api, calls)),
    });
    const result = (await subject.read(ticket)).ticket;
    expect(result).toMatchObject({ title: "Live summary", description: "Live description" });
    expect([...new Set(calls.map((call) => new URL(call.url).origin))]).toEqual([
      "https://responsibid.atlassian.net",
    ]);
    for (const call of calls)
      expect(call.request.headers).toMatchObject({
        Authorization: `Basic ${btoa("lane@example.com:token-value")}`,
        Accept: "application/json",
      });
    expect(calls[0]?.request).toMatchObject({ method: "GET" });
    expect(calls[0]?.url).toContain("fields=summary,description");
    expect(api.mutationCount()).toBe(0);
  });

  test("rejects a non-origin site without echoing any credential", () => {
    for (const site of [
      "http://responsibid.atlassian.net",
      "https://u:p@x.net",
      "https://x.net/a",
    ]) {
      let message = "";
      try {
        jiraBasicAuthTransport({ ...jiraCredentials, site });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("Jira site must be an https site origin");
      expect(message).not.toContain("token-value");
    }
  });

  test("refuses non-REST paths and keeps status for non-JSON responses", async () => {
    const http: HttpTransport = async () => new Response("<html>gateway</html>", { status: 502 });
    const transport = jiraBasicAuthTransport(jiraCredentials, http);
    await expectRejection(transport.request("GET", "//evil.example/rest")).toThrow(
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
              ...(fields.assignee
                ? { assignee: actorRefSchema.parse(fields.assignee.accountId) }
                : {}),
            },
            mirror: mirror && { ticket, ...mirror },
            writes: api.mutationCount(),
          };
        },
        changeOwner: async (owner) => reassign(api, owner),
        loseWriteReadback() {
          const before = api.mutationCount();
          api.fail = (method) =>
            method === "GET" && api.mutationCount() > before ? 503 : undefined;
        },
      };
    }),
  );
  expect(report.results.filter((result) => !result.ok)).toEqual([]);
});

test.each([
  ["release", "status"],
  ["release", "assignee"],
  ["release", "property"],
  ["compensation", "status"],
  ["compensation", "assignee"],
  ["compensation", "property"],
])(
  "%s retains ownership when Jira acknowledges a no-op %s restoration",
  async (operation, field) => {
    const api = new FakeJira();
    const { first } = await lockedJira(api);
    const original = await first.snapshotClaimState(ticket);
    const request = claimRequest(owner, "guarded", original.version);
    await first.claim(request);
    const held = await first.snapshotClaimState(ticket);
    api.fail = (method, path) =>
      (field === "status" && method === "POST" && path.endsWith("/transitions")) ||
      (field === "assignee" && method === "PUT" && path.endsWith("/assignee")) ||
      (field === "property" && method === "DELETE" && path.includes("/properties/"))
        ? 204
        : undefined;
    const restore = {
      ...request,
      claimedOwner: owner,
      originalSnapshot: original,
      expectedVersion: held.version,
      authorizedBy: owner,
    };
    await expectRejection(
      operation === "release" ? first.releaseClaim(restore) : first.restoreClaimState(restore),
    ).toThrow();
    expect((await first.snapshotClaimState(ticket)).version).toBe(held.version);
    expect(api.claimProperty).toMatchObject({ claim: request.claim });
    api.fail = () => undefined;
    if (operation === "release") await first.releaseClaim(restore);
    else await first.restoreClaimState(restore);
    await first.verifyRestored(restore);
    expect(api.mirror()).toEqual({ assignee: null, status: "To Do", claim: null });
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each([202, 500])(
  "Jira HTTP %s cannot establish that a pending write is finished",
  async (status) => {
    const api = new FakeJira();
    const { first } = await lockedJira(api);
    const original = await first.snapshotClaimState(ticket);
    const request = claimRequest(owner, "pending-response", original.version);
    api.fail = (method, path) =>
      method === "PUT" && path.endsWith("/assignee") ? status : undefined;
    await expectRejection(first.claim(request)).toThrow("outcome is unknown");
    const held = await first.snapshotClaimState(ticket);
    const restore = {
      ticket,
      claim: request.claim,
      claimedOwner: owner,
      originalSnapshot: original,
    };
    await expectRejection(first.restoreClaimState(restore)).toThrow("outcome is unknown");
    expect((await first.snapshotClaimState(ticket)).version).toBe(held.version);
    expect(api.claimProperty).toMatchObject({ claim: request.claim });
    reassign(api, owner);
    api.fail = () => undefined;
    await first.restoreClaimState(restore);
    await first.verifyRestored(restore);
    expect(api.mirror()).toEqual({ claim: null, assignee: null, status: "To Do" });
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each(["release", "compensation"])(
  "%s verifies the tracker restoration before dropping the Git lock",
  async (operation) => {
    const api = new FakeJira();
    const tracker = adapter(api);
    const { first } = await lockedJira(api, tracker);
    const original = await first.snapshotClaimState(ticket);
    const request = claimRequest(owner, "verify-restore", original.version);
    await first.claim(request);
    const held = await first.snapshotClaimState(ticket);
    tracker.restore = async () => {};
    const restore = {
      ...request,
      claimedOwner: owner,
      originalSnapshot: original,
      expectedVersion: held.version,
      authorizedBy: owner,
    };
    await expectRejection(
      operation === "release" ? first.releaseClaim(restore) : first.restoreClaimState(restore),
    ).toThrow("Jira restored state could not be verified");
    expect((await first.snapshotClaimState(ticket)).version).toBe(held.version);
    expect(api.claimProperty).toMatchObject({ claim: request.claim });
  },
  GIT_TEST_TIMEOUT_MS,
);

test("an acknowledged no-op claim property write cannot advance assignment or status", async () => {
  const api = new FakeJira();
  api.fail = (method, path) =>
    method === "PUT" && path.includes("/properties/") ? 204 : undefined;
  await expectRejection(adapter(api).apply(claimRequest(owner, "property", "v1"))).toThrow(
    "Jira claim property was not verified",
  );
  expect(api.mirror()).toEqual({ assignee: null, status: "To Do", claim: null });
  expect(api.mutationCount()).toBe(1);
});

test("Jira declares the structured mirror tier and needs no read configuration", async () => {
  const api = new FakeJira();
  const subject = new JiraTrackerAdapter({
    instance: "responsibid",
    namespace: "JWB",
    transport: api,
    claimHome: "github.com/jarenkempton/interlock",
  });
  expect(subject.mirror).toBe("structured");
  expect((await subject.read(ticket)).ticket.ref).toBe(ticket);
  const claim = claimRequest(owner, "c", "absent");
  await subject.apply(claim);
  await subject.verify({ ...claim, state: "applied" });
  await subject.restore(restoreRequest());
  await subject.verify({ ...restoreRequest(), state: "restored" });
  expect(api.mirror()).toEqual({ assignee: null, status: "To Do", claim: null });
  expect(api.requests.some((request) => request.path.includes("customfield"))).toBe(false);
});

test.each([
  [
    "an older",
    { claim: "interlock-claim:c", run: "interlock-run:c", owner: "account" },
    "written before claim homes; remove the interlock.claim property from JWB-288 and refs/interlock/claims/JWB-288",
  ],
  [
    "a newer",
    { claim: "interlock-claim:c", version: 3, future: true },
    "version 3; upgrade Interlock",
  ],
])(
  "the mirror reads the version first and leaves %s claim property untouched",
  async (_, property, message) => {
    const api = new FakeJira();
    api.claimProperty = property;
    await expectRejection(adapter(api).read(ticket)).toThrow(message);
    await expectRejection(adapter(api).apply(claimRequest(owner, "c", "absent"))).toThrow(message);
    await expectRejection(adapter(api).restore(restoreRequest())).toThrow(message);
    expect(api.claimProperty).toEqual(property);
    expect(api.mutationCount()).toBe(0);
  },
);

test("a claim property from another claim home names that home and is never overwritten", async () => {
  const api = new FakeJira();
  const property = {
    claim: "interlock-claim:c",
    run: "interlock-run:c",
    owner,
    home: "github.com/other/home",
    version: 2,
  };
  api.claimProperty = property;
  await expectRejection(adapter(api).apply(claimRequest(owner, "c", "absent"))).toThrow(
    "claim home github.com/other/home",
  );
  await expectRejection(adapter(api).restore(restoreRequest())).toBeInstanceOf(ClaimCollisionError);
  await expectRejection(
    adapter(api).verify({ ...claimRequest(owner, "c", "absent"), state: "applied" }),
  ).toBeInstanceOf(AmbiguousTrackerResultError);
  expect(api.claimProperty).toEqual(property);
  expect(api.mutationCount()).toBe(0);
});

class FakeRemoteLinks implements JiraTransport {
  links = new Map<string, { url: string; title: string }>();
  posts = 0;
  postOutcome: "ok" | "lost_response" | "server_error" | "forbidden" | "not_applied" = "ok";
  readback: "ok" | "fail" | "other_url" = "ok";

  async request(method: string, path: string, body?: unknown): Promise<JiraResponse> {
    if (!path.startsWith("/rest/api/3/issue/JWB-1/remotelink")) return { status: 404 };
    if (method === "GET") {
      const globalId = decodeURIComponent(path.split("globalId=")[1] ?? "");
      if (this.posts > 0 && this.readback === "fail") throw new Error("network");
      const link = this.links.get(globalId);
      if (!link) return { status: 404 };
      const url = this.posts > 0 && this.readback === "other_url" ? "https://other.test" : link.url;
      return { status: 200, body: { id: 10, globalId, object: { ...link, url } } };
    }
    this.posts += 1;
    if (this.postOutcome === "forbidden") return { status: 403 };
    const request = z
      .object({ globalId: z.string(), object: z.object({ url: z.string(), title: z.string() }) })
      .parse(body);
    if (this.postOutcome !== "not_applied") this.links.set(request.globalId, request.object);
    if (this.postOutcome === "lost_response") throw new Error("connection reset");
    if (this.postOutcome === "server_error") return { status: 503 };
    return { status: 201, body: { id: 10 } };
  }
}

describe("Jira link_artifact", () => {
  const pr = "https://github.com/o/r/pull/7";
  const linkTicket = ticketRefSchema.parse("jira:responsibid:JWB:ticket:JWB-1");
  const linker = (api: FakeRemoteLinks) =>
    new JiraTrackerAdapter({ instance: "responsibid", namespace: "JWB", transport: api });

  test("writes one remote link keyed by the PR URL and reads it back", async () => {
    const api = new FakeRemoteLinks();
    await linker(api).linkArtifact(linkTicket, pr, "JWB-1: title");
    expect(api.links.get(pr)).toEqual({ url: pr, title: "JWB-1: title" });
    expect(api.posts).toBe(1);
  });

  test("an already-linked PR is adopted without a duplicate write", async () => {
    const api = new FakeRemoteLinks();
    api.links.set(pr, { url: pr, title: "existing" });
    await linker(api).linkArtifact(linkTicket, pr);
    expect(api.posts).toBe(0);
    expect(api.links.size).toBe(1);
  });

  test("a different link under the same globalId is refused, not overwritten", async () => {
    const api = new FakeRemoteLinks();
    api.links.set(pr, { url: "https://elsewhere.test", title: "other" });
    await expectRejection(linker(api).linkArtifact(linkTicket, pr)).toBeInstanceOf(
      ArtifactLinkConflictError,
    );
    expect(api.posts).toBe(0);
  });

  test("a readback mismatch or missing link after a write is ambiguous", async () => {
    for (const setup of [
      (api: FakeRemoteLinks) => {
        api.readback = "other_url";
      },
      (api: FakeRemoteLinks) => {
        api.postOutcome = "not_applied";
      },
    ]) {
      const api = new FakeRemoteLinks();
      setup(api);
      await expectRejection(linker(api).linkArtifact(linkTicket, pr)).toBeInstanceOf(
        AmbiguousTrackerResultError,
      );
    }
  });

  test("an ambiguous write is resolved by readback, and a retry adopts the link", async () => {
    const lost = new FakeRemoteLinks();
    lost.postOutcome = "lost_response";
    await linker(lost).linkArtifact(linkTicket, pr);
    expect(lost.links.size).toBe(1);

    const unreadable = new FakeRemoteLinks();
    unreadable.postOutcome = "server_error";
    unreadable.readback = "fail";
    await expectRejection(linker(unreadable).linkArtifact(linkTicket, pr)).toBeInstanceOf(
      AmbiguousTrackerResultError,
    );
    unreadable.readback = "ok";
    unreadable.posts = 0;
    await linker(unreadable).linkArtifact(linkTicket, pr);
    expect(unreadable.posts).toBe(0);
    expect(unreadable.links.size).toBe(1);
  });

  test("a definite rejection is a plain failure, not ambiguous", async () => {
    const api = new FakeRemoteLinks();
    api.postOutcome = "forbidden";
    const failure = linker(api).linkArtifact(linkTicket, pr);
    await expectRejection(failure).toThrow("Jira link artifact failed (403)");
    await expectRejection(linker(api).linkArtifact(linkTicket, pr)).not.toBeInstanceOf(
      AmbiguousTrackerResultError,
    );
  });
});

test("jiraOrigin keeps dotted hosts, ports and a trailing slash, and refuses bare host names", () => {
  for (const [site, origin] of [
    ["example.atlassian.net", "https://example.atlassian.net"],
    ["https://Example.Atlassian.net/", "https://example.atlassian.net"],
    ["https://jira.example.com:8443", "https://jira.example.com:8443"],
  ] as const)
    expect(jiraOrigin(site)).toBe(origin);
  for (const site of ["h", "https://jira", "jira:8443", "https://example.net."])
    expect(() => jiraOrigin(site)).toThrow("https site origin");
});
