import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { JiraTransport } from "../src/adapters/trackers/jira.ts";
import { run as runCli } from "../src/cli.ts";
import {
  AmbiguousTrackerResultError,
  ArtifactLinkConflictError,
  TrackerUnavailableError,
} from "../src/domain/contracts.ts";
import {
  adapterRefSchema,
  laneRefSchema,
  runRefSchema,
  ticketRefSchema,
} from "../src/domain/identifiers.ts";
import type { LaneRef, TicketRef } from "../src/domain/model.ts";
import {
  type ArtifactHost,
  type ArtifactRequest,
  type ArtifactTarget,
  type ArtifactWorkspace,
  LaneService,
  type LaneTrackerPort,
  type PullRequest,
} from "../src/execution/lane.ts";
import { StateStore } from "../src/persistence/state.ts";
import type { RuntimeServices } from "../src/runtime-services.ts";
import { FakeSubmissionAuthority } from "./fixtures/submission.ts";

const ticket = ticketRefSchema.parse("jira:x:W:ticket:JWB-878");
const runRef = runRefSchema.parse("interlock-run:submit");
const branch = "feature/JWB-878-core-pr";
const prUrl = "https://github.com/o/r/pull/7";

function evidence(head: string) {
  return [{ gate: "test", head, url: `https://ci.test/${head}` }];
}

class FakeArtifacts implements ArtifactHost {
  open_: PullRequest[] = [];
  pushes: { workspace: ArtifactWorkspace; head: string }[] = [];
  opens: ArtifactRequest[] = [];
  failPush = false;
  failList = false;
  openOutcome: "created" | "lost_response" | "failed" = "created";

  async prepare(workspace: ArtifactWorkspace, head: string): Promise<ArtifactTarget> {
    return {
      ...workspace,
      head,
      repository: "github.com/o/r",
      remote: "https://github.com/o/r.git",
    };
  }
  async push(workspace: ArtifactTarget) {
    this.pushes.push({ workspace, head: workspace.head });
    if (this.failPush) throw new Error("rejected");
  }

  async pullRequests(workspace: ArtifactWorkspace, key?: string) {
    if (this.failList) throw new Error("gh unavailable");
    return this.open_.filter(
      (item) => item.branch === workspace.branch || (key !== undefined && item.url.includes(key)),
    );
  }

  async open(workspace: ArtifactWorkspace, request: ArtifactRequest) {
    this.opens.push(request);
    if (this.openOutcome === "failed") throw new Error("gh pr create failed");
    const created: PullRequest = {
      url: prUrl,
      branch: workspace.branch,
      title: request.title,
      state: "OPEN",
    };
    this.open_.push(created);
    if (this.openOutcome === "lost_response") throw new Error("connection reset");
    return created;
  }
}

class LinkingTracker implements LaneTrackerPort {
  links: string[] = [];
  titles: (string | undefined)[] = [];
  failWith: Error | undefined;
  unavailable = false;
  async read(): Promise<never> {
    throw new Error("not used");
  }
  async available() {
    if (this.unavailable) throw new TrackerUnavailableError("Not signed in to Jira");
  }
  async link_artifact(_ticket: TicketRef, url: string, title?: string) {
    this.links.push(url);
    this.titles.push(title);
    if (this.failWith) throw this.failWith;
  }
}

function setup(
  options: {
    branch?: string;
    tracker?: LaneTrackerPort | null;
    artifacts?: boolean;
    submissions?: FakeSubmissionAuthority;
    host?: FakeArtifacts;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "interlock-submit-"));
  const store = new StateStore(join(directory, "interlock.db"));
  store.saveRun({
    ref: runRef,
    ticket,
    harness: adapterRefSchema.parse("t3"),
    workspace: { path: directory, branch: options.branch ?? branch },
    capabilities: {},
    status: "claimed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const artifacts = options.host ?? new FakeArtifacts();
  const tracker = options.tracker === undefined ? new LinkingTracker() : options.tracker;
  const service = new LaneService({
    store,
    submissions: options.submissions ?? new FakeSubmissionAuthority(),
    ...(tracker ? { tracker } : {}),
    ...(options.artifacts === false ? {} : { artifacts }),
    newId: () => laneRefSchema.parse("interlock-lane:submit"),
  });
  return {
    service,
    store,
    artifacts,
    tracker,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function implementing(service: LaneService): Promise<LaneRef> {
  const created = service.create({ ticket: String(ticket) });
  if (!created.ok) throw new Error(created.refusal.message);
  await service.apply(created.value.id, {
    type: "claim",
    run: runRef,
    claim: "interlock-claim:submit",
  });
  await service.apply(created.value.id, { type: "start" });
  return created.value.id;
}

async function requestChanges(service: LaneService, id: LaneRef, head: string) {
  await service.apply(id, { type: "begin_review" });
  await service.apply(id, {
    type: "verdict",
    head,
    decision: "changes_requested",
    findings: ["x"],
  });
}

test("submit pushes the recorded branch, opens one PR with the key, records and links it", async () => {
  const tracker = new LinkingTracker();
  const { service, store, artifacts, cleanup } = setup({ tracker });
  try {
    const id = await implementing(service);
    const submitted = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(submitted).toMatchObject({ ok: true, value: { state: "submitted", artifact: prUrl } });
    expect(artifacts.pushes).toEqual([
      { workspace: expect.objectContaining({ branch }), head: "abc" },
    ]);
    expect(artifacts.opens).toHaveLength(1);
    expect(artifacts.opens[0]?.title).toContain("JWB-878");
    expect(store.lane(id).artifact).toBe(prUrl);
    expect(tracker.links).toEqual([prUrl]);
    expect(tracker.titles[0]).toContain("JWB-878");

    await requestChanges(service, id, "abc");
    const resubmitted = await service.submit(id, { head: "def", evidence: evidence("def") });
    expect(resubmitted).toMatchObject({ ok: true, value: { artifact: prUrl, head: "def" } });
    expect(artifacts.opens).toHaveLength(1);
    expect(artifacts.pushes.map((item) => item.head)).toEqual(["abc", "def"]);
  } finally {
    cleanup();
  }
});

test("an existing PR on the lane branch is adopted instead of opening another", async () => {
  const { service, artifacts, cleanup } = setup();
  try {
    artifacts.open_.push({ url: prUrl, branch, title: "JWB-878: existing", state: "OPEN" });
    const id = await implementing(service);
    const submitted = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(submitted).toMatchObject({ ok: true, value: { artifact: prUrl } });
    expect(artifacts.opens).toEqual([]);
  } finally {
    cleanup();
  }
});

test("a second PR for the ticket is refused with duplicate_artifact before any push", async () => {
  const { service, artifacts, cleanup } = setup();
  try {
    artifacts.open_.push({
      url: "https://github.com/o/r/pull/JWB-878-other",
      branch: "other",
      state: "OPEN",
    });
    const id = await implementing(service);
    const refused = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(refused).toMatchObject({ ok: false, refusal: { code: "duplicate_artifact" } });
    expect(artifacts.pushes).toEqual([]);
    expect(artifacts.opens).toEqual([]);
    expect(service.get(id)).toMatchObject({ ok: true, value: { state: "implementing" } });
  } finally {
    cleanup();
  }
});

test("a lane whose recorded PR is no longer open refuses to open a replacement", async () => {
  const { service, artifacts, cleanup } = setup();
  try {
    const id = await implementing(service);
    await service.submit(id, { head: "abc", evidence: evidence("abc") });
    await requestChanges(service, id, "abc");
    artifacts.open_ = [];
    const refused = await service.submit(id, { head: "def", evidence: evidence("def") });
    expect(refused).toMatchObject({ ok: false, refusal: { code: "duplicate_artifact" } });
    expect(artifacts.opens).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("a push failure leaves the lane implementing and opens nothing", async () => {
  const { service, artifacts, cleanup } = setup();
  try {
    artifacts.failPush = true;
    const id = await implementing(service);
    const refused = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(refused).toMatchObject({ ok: false, refusal: { code: "push_failed" } });
    expect(artifacts.opens).toEqual([]);
    expect(service.get(id)).toMatchObject({ ok: true, value: { state: "implementing" } });
  } finally {
    cleanup();
  }
});

test("an ambiguous create adopts the PR it finds on readback", async () => {
  const { service, artifacts, cleanup } = setup();
  try {
    artifacts.openOutcome = "lost_response";
    const id = await implementing(service);
    const submitted = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(submitted).toMatchObject({ ok: true, value: { artifact: prUrl } });
    expect(artifacts.opens).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("an unverified create cannot be retried as another create", async () => {
  const { service, artifacts, cleanup } = setup();
  try {
    artifacts.openOutcome = "failed";
    const id = await implementing(service);
    const refused = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(refused).toMatchObject({ ok: false, refusal: { code: "ambiguous_write" } });
    expect(service.get(id)).toMatchObject({ ok: true, value: { state: "implementing" } });
    artifacts.openOutcome = "created";
    const retried = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(retried).toMatchObject({ ok: false, refusal: { code: "recovery_required" } });
    expect(artifacts.opens).toHaveLength(1);
    expect(artifacts.open_).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("an unverified tracker link is ambiguous_write and a retry relinks the same PR", async () => {
  const tracker = new LinkingTracker();
  tracker.failWith = new AmbiguousTrackerResultError("Jira remote link was not verified");
  const { service, artifacts, cleanup } = setup({ tracker });
  try {
    const id = await implementing(service);
    const refused = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(refused).toMatchObject({ ok: false, refusal: { code: "ambiguous_write" } });
    expect(service.get(id)).toMatchObject({ ok: true, value: { state: "implementing" } });
    tracker.failWith = undefined;
    const retried = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(retried).toMatchObject({ ok: true, value: { artifact: prUrl } });
    expect(artifacts.opens).toHaveLength(1);
    expect(tracker.links).toEqual([prUrl, prUrl]);
  } finally {
    cleanup();
  }
});

test("submit refuses without a host, workspace, key-bearing branch or readable PR list", async () => {
  const cases = [
    { options: { artifacts: false }, code: "unsupported_capability" },
    { options: { branch: "feature/no-key" }, code: "gates_unmet" },
    { options: {}, failList: true, code: "artifact_host_unavailable" },
  ] as const;
  for (const item of cases) {
    const { service, artifacts, cleanup } = setup(item.options);
    try {
      artifacts.failList = "failList" in item;
      const id = await implementing(service);
      const refused = await service.submit(id, { head: "abc", evidence: evidence("abc") });
      expect(refused).toMatchObject({ ok: false, refusal: { code: item.code } });
      expect(artifacts.pushes).toEqual([]);
    } finally {
      cleanup();
    }
  }
  const { service, artifacts, cleanup } = setup();
  try {
    const created = service.create({ ticket: String(ticket) });
    if (!created.ok) throw new Error(created.refusal.message);
    await service.apply(created.value.id, {
      type: "claim",
      run: runRefSchema.parse("interlock-run:unknown"),
      claim: "interlock-claim:submit",
    });
    await service.apply(created.value.id, { type: "start" });
    const refused = await service.submit(created.value.id, {
      head: "abc",
      evidence: evidence("abc"),
    });
    expect(refused).toMatchObject({ ok: false, refusal: { code: "workspace_unknown" } });
    expect(
      await service.submit(created.value.id, { head: "abc", evidence: evidence("other") }),
    ).toMatchObject({ ok: false, refusal: { code: "stale_evidence" } });
    expect(artifacts.pushes).toEqual([]);
  } finally {
    cleanup();
  }
});

test("CLI lane submit goes through the artifact host and records the PR", async () => {
  const directory = mkdtempSync(join(tmpdir(), "interlock-submit-cli-"));
  const statePath = join(directory, "interlock.db");
  const seed = new StateStore(statePath);
  seed.saveRun({
    ref: runRef,
    ticket,
    harness: adapterRefSchema.parse("t3"),
    workspace: { path: directory, branch },
    capabilities: {},
    status: "claimed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  seed.close();
  const artifacts = new FakeArtifacts();
  const tracker = new LinkingTracker();
  const services = {
    statePath,
    lane: { artifacts, tracker, submissions: new FakeSubmissionAuthority() },
  };
  const call = async (args: string[]) => {
    const output: string[] = [];
    const code = await runCli([...args, "--json"], (text) => output.push(text), services);
    return { code, value: JSON.parse(output.join("\n")) };
  };
  try {
    const id = (await call(["lane", "create", "--ticket", String(ticket)])).value.value.id;
    await call(["lane", "claim", id, "--run", runRef]);
    await call(["lane", "start", id]);
    const args = ["lane", "submit", id, "--head", "abc", "--gate", "test"];
    const submitted = await call([...args, "--evidence-url", "https://ci.test/abc", "--draft"]);
    expect(submitted.code).toBe(0);
    expect(submitted.value.value.artifact).toBe(prUrl);
    expect(artifacts.opens[0]?.draft).toBe(true);
    expect(tracker.links).toEqual([prUrl]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a ticket lane refuses tracker_unavailable before any push when it cannot link", async () => {
  for (const tracker of [null, Object.assign(new LinkingTracker(), { unavailable: true })]) {
    const { service, artifacts, cleanup } = setup({ tracker });
    try {
      const id = await implementing(service);
      const refused = await service.submit(id, { head: "abc", evidence: evidence("abc") });
      expect(refused).toMatchObject({ ok: false, refusal: { code: "tracker_unavailable" } });
      expect(artifacts.pushes).toEqual([]);
    } finally {
      cleanup();
    }
  }
});

test("tracker link conflicts and definite failures refuse with distinct codes", async () => {
  const cases = [
    { error: new ArtifactLinkConflictError("different link"), code: "artifact_mismatch" },
    { error: new Error("Jira link artifact failed (403)"), code: "tracker_write_failed" },
    { error: new TrackerUnavailableError("signed out"), code: "tracker_unavailable" },
  ];
  for (const item of cases) {
    const tracker = Object.assign(new LinkingTracker(), { failWith: item.error });
    const { service, cleanup } = setup({ tracker });
    try {
      const id = await implementing(service);
      const refused = await service.submit(id, { head: "abc", evidence: evidence("abc") });
      expect(refused).toMatchObject({ ok: false, refusal: { code: item.code } });
      expect(service.get(id)).toMatchObject({ ok: true, value: { state: "implementing" } });
    } finally {
      cleanup();
    }
  }
});

async function cliLane(services: RuntimeServices, statePath: string, directory: string) {
  const jiraTicket = "jira:responsibid:JWB:ticket:JWB-878";
  const seed = new StateStore(statePath);
  seed.saveRun({
    ref: runRef,
    ticket: ticketRefSchema.parse(jiraTicket),
    harness: adapterRefSchema.parse("t3"),
    workspace: { path: directory, branch },
    capabilities: {},
    status: "claimed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  seed.close();
  const call = async (args: string[]) => {
    const output: string[] = [];
    const code = await runCli([...args, "--json"], (text) => output.push(text), services);
    return { code, value: JSON.parse(output.join("\n")) };
  };
  const id = (await call(["lane", "create", "--ticket", jiraTicket])).value.value.id;
  await call(["lane", "claim", id, "--run", runRef]);
  await call(["lane", "start", id]);
  const submit = ["lane", "submit", id, "--head", "abc", "--gate", "t"];
  return call([...submit, "--evidence-url", "https://ci.test/abc"]);
}

const emptyCredentials = {
  read: async () => undefined,
  write: async () => {},
  delete: async () => {},
};

test("CLI submit without Jira sign-in refuses tracker_unavailable and never pushes", async () => {
  for (const environment of [{}, { JIRA_SITE: "https://responsibid.atlassian.net" }]) {
    const directory = mkdtempSync(join(tmpdir(), "interlock-submit-signin-"));
    const artifacts = new FakeArtifacts();
    const statePath = join(directory, "interlock.db");
    try {
      const services = {
        statePath,
        lane: { artifacts },
        signIn: { environment, credentials: emptyCredentials },
      };
      const submitted = await cliLane(services, statePath, directory);
      expect(submitted.code).toBe(1);
      expect(submitted.value.refusal.code).toBe("tracker_unavailable");
      expect(artifacts.pushes).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("CLI submit reaches the signed-in Jira adapter and writes one verified remote link", async () => {
  const directory = mkdtempSync(join(tmpdir(), "interlock-submit-jira-"));
  const statePath = join(directory, "interlock.db");
  const links = new Map<string, unknown>();
  const posts: unknown[] = [];
  const jira: JiraTransport = {
    async request(method, path, body) {
      if (!path.startsWith("/rest/api/3/issue/JWB-878/remotelink")) return { status: 404 };
      if (method === "POST") {
        posts.push(body);
        const parsed = z.object({ globalId: z.string(), object: z.unknown() }).parse(body);
        links.set(parsed.globalId, { object: parsed.object });
        return { status: 201 };
      }
      const link = links.get(decodeURIComponent(path.split("globalId=")[1] ?? ""));
      return link ? { status: 200, body: link } : { status: 404 };
    },
  };
  try {
    const services = {
      statePath,
      lane: { artifacts: new FakeArtifacts(), submissions: new FakeSubmissionAuthority() },
      execution: { jira },
      signIn: {
        environment: { JIRA_SITE: "https://responsibid.atlassian.net" },
        credentials: emptyCredentials,
      },
    };
    const submitted = await cliLane(services, statePath, directory);
    expect(submitted.code).toBe(0);
    expect(submitted.value.value.artifact).toBe(prUrl);
    expect([...links.keys()]).toEqual([prUrl]);
    expect(posts).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("separate ledgers racing the same ticket cannot both create PRs", async () => {
  const submissions = new FakeSubmissionAuthority();
  const host = new FakeArtifacts();
  const first = setup({ submissions, host, branch: "work/JWB-878-first" });
  const second = setup({ submissions, host, branch: "work/JWB-878-second" });
  try {
    const a = await implementing(first.service);
    const b = await implementing(second.service);
    const results = await Promise.all([
      first.service.submit(a, { head: "abc", evidence: evidence("abc") }),
      second.service.submit(b, { head: "abc", evidence: evidence("abc") }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      refusal: { code: "duplicate_artifact" },
    });
    expect(host.opens).toHaveLength(1);
    expect(host.pushes).toHaveLength(1);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("tracker failure retains the PR identity before a retry after closure", async () => {
  const tracker = new LinkingTracker();
  tracker.failWith = new Error("403");
  const { service, store, artifacts, cleanup } = setup({ tracker });
  try {
    const id = await implementing(service);
    expect(await service.submit(id, { head: "abc", evidence: evidence("abc") })).toMatchObject({
      ok: false,
      refusal: { code: "tracker_write_failed" },
    });
    expect(store.lane(id)).toMatchObject({ artifact: prUrl, state: "implementing" });
    artifacts.open_ = [];
    tracker.failWith = undefined;
    expect(await service.submit(id, { head: "abc", evidence: evidence("abc") })).toMatchObject({
      ok: false,
      refusal: { code: "duplicate_artifact" },
    });
    expect(artifacts.opens).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("a similarly prefixed ticket is not the branch ticket", async () => {
  for (const branch of ["feature/JWB-8780-core", "task/X_JWB-878"]) {
    const { service, artifacts, cleanup } = setup({ branch });
    try {
      const id = await implementing(service);
      expect(await service.submit(id, { head: "abc", evidence: evidence("abc") })).toMatchObject({
        ok: false,
        refusal: { code: "gates_unmet" },
      });
      expect(artifacts.pushes).toEqual([]);
    } finally {
      cleanup();
    }
  }
});

test("title prefix and existing title checks require the complete ticket key", async () => {
  for (const title of ["JWB-8780: other", "X_JWB-878: other"]) {
    const first = setup();
    try {
      const id = await implementing(first.service);
      await first.service.submit(id, { head: "abc", evidence: evidence("abc"), title });
      expect(first.artifacts.opens[0]?.title).toBe(`JWB-878: ${title}`);
    } finally {
      first.cleanup();
    }
  }
  for (const title of ["Unrelated feature", "JWB-8780: other", "X_JWB-878: other"]) {
    const { service, artifacts, cleanup } = setup();
    try {
      artifacts.open_ = [{ url: prUrl, branch, title, state: "OPEN" }];
      const id = await implementing(service);
      expect(await service.submit(id, { head: "abc", evidence: evidence("abc") })).toMatchObject({
        ok: false,
        refusal: { code: "artifact_mismatch" },
      });
      expect(artifacts.pushes).toEqual([]);
    } finally {
      cleanup();
    }
  }
});

test("a reserved ambiguous create can only adopt its eventual PR, even after service restart", async () => {
  const submissions = new FakeSubmissionAuthority();
  const fixture = setup({ submissions });
  try {
    const id = await implementing(fixture.service);
    fixture.artifacts.openOutcome = "failed";
    await fixture.service.submit(id, { head: "abc", evidence: evidence("abc") });
    const restarted = new LaneService({
      store: fixture.store,
      submissions,
      artifacts: fixture.artifacts,
      ...(fixture.tracker ? { tracker: fixture.tracker } : {}),
    });
    expect(await restarted.submit(id, { head: "abc", evidence: evidence("abc") })).toMatchObject({
      ok: false,
      refusal: { code: "recovery_required" },
    });
    fixture.artifacts.open_ = [{ url: prUrl, branch, title: "JWB-878: delayed", state: "OPEN" }];
    expect(await restarted.submit(id, { head: "abc", evidence: evidence("abc") })).toMatchObject({
      ok: true,
      value: { artifact: prUrl },
    });
    expect(fixture.artifacts.opens).toHaveLength(1);
  } finally {
    fixture.cleanup();
  }
});
