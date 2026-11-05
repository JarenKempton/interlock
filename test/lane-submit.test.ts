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
import { GitClaimLock } from "../src/adapters/claims/git-lock.ts";
import { BunGitCommandExecutor } from "../src/adapters/workspaces/git.ts";
import { normalizeClaimHome } from "../src/domain/claim-home.ts";
import { actorRefSchema, claimRefSchema } from "../src/domain/identifiers.ts";
import { checkedGit } from "./fixtures/git-remote.ts";

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

async function seedClaim(store: StateStore, directory: string) {
  const git = new BunGitCommandExecutor();
  const home = normalizeClaimHome(join(directory, "claim.git"));
  await checkedGit(git, ["init", "--quiet", directory], directory);
  await checkedGit(git, ["init", "--quiet", "--bare", home.url], directory);
  const run = store.run(runRef);
  const claim = {
    ref: claimRefSchema.parse("interlock-claim:submit"),
    run: run.ref,
    ticket: run.ticket,
    humanOwner: actorRefSchema.parse("owner"),
    status: "active" as const,
    previousState: { version: "1", payload: null },
    claimedAt: "2026-01-01T00:00:00.000Z",
    leaseExpiresAt: "2099-01-01T00:00:00Z",
    claimHome: home.identity,
    claimHomeUrl: home.url,
  };
  store.saveClaim(claim);
  const lock = new GitClaimLock({ repository: directory, home, git });
  await lock.claim({
    ticket: run.ticket,
    claim: claim.ref,
    run: run.ref,
    owner: claim.humanOwner,
    leaseExpiresAt: claim.leaseExpiresAt,
    expectedVersion: "absent",
  });
  return { claim, lock, git };
}

async function setup(
  options: {
    branch?: string;
    tracker?: LaneTrackerPort | null;
    artifacts?: boolean;
    host?: FakeArtifacts;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "interlock-submit-"));
  const store = new StateStore(join(directory, "interlock.db"));
  store.saveRun({
    ref: runRef,
    ticket,
    host: adapterRefSchema.parse("t3"),
    harness: adapterRefSchema.parse("t3"),
    workspace: { path: directory, branch: options.branch ?? branch },
    capabilities: {},
    status: "claimed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const ownership = await seedClaim(store, directory);
  const artifacts = options.host ?? new FakeArtifacts();
  const tracker = options.tracker === undefined ? new LinkingTracker() : options.tracker;
  const service = new LaneService({
    store,
    ...(tracker ? { tracker } : {}),
    ...(options.artifacts === false ? {} : { artifacts }),
    newId: () => laneRefSchema.parse("interlock-lane:submit"),
  });
  return {
    service,
    store,
    ...ownership,
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
  const { service, store, artifacts, cleanup } = await setup({ tracker });
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
  const { service, artifacts, cleanup } = await setup();
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
  const { service, artifacts, cleanup } = await setup();
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
  const { service, artifacts, cleanup } = await setup();
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

test("a failed push followed by a retry opens exactly one PR", async () => {
  const { service, artifacts, cleanup } = await setup();
  try {
    artifacts.failPush = true;
    const id = await implementing(service);
    const refused = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(refused).toMatchObject({ ok: false, refusal: { code: "push_failed" } });
    expect(artifacts.opens).toEqual([]);
    expect(service.get(id)).toMatchObject({ ok: true, value: { state: "implementing" } });
    artifacts.failPush = false;
    expect(await service.submit(id, { head: "abc", evidence: evidence("abc") })).toMatchObject({
      ok: true,
      value: { state: "submitted", artifact: prUrl },
    });
    expect(artifacts.opens).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("an ambiguous create adopts the PR it finds on readback", async () => {
  const { service, artifacts, cleanup } = await setup();
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

test("an unverified create retries after a fresh lookup finds no PR", async () => {
  const { service, artifacts, cleanup } = await setup();
  try {
    artifacts.openOutcome = "failed";
    const id = await implementing(service);
    const refused = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(refused).toMatchObject({ ok: false, refusal: { code: "ambiguous_write" } });
    expect(service.get(id)).toMatchObject({ ok: true, value: { state: "implementing" } });
    artifacts.openOutcome = "created";
    const retried = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(retried).toMatchObject({ ok: true, value: { artifact: prUrl } });
    expect(artifacts.opens).toHaveLength(2);
    expect(artifacts.open_).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test("an unverified tracker link is ambiguous_write and a retry relinks the same PR", async () => {
  const tracker = new LinkingTracker();
  tracker.failWith = new AmbiguousTrackerResultError("Jira remote link was not verified");
  const { service, artifacts, cleanup } = await setup({ tracker });
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
    const { service, artifacts, cleanup } = await setup(item.options);
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
  const { service, artifacts, cleanup } = await setup();
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
    host: adapterRefSchema.parse("t3"),
    harness: adapterRefSchema.parse("t3"),
    workspace: { path: directory, branch },
    capabilities: {},
    status: "claimed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await seedClaim(seed, directory);
  seed.close();
  const artifacts = new FakeArtifacts();
  const tracker = new LinkingTracker();
  const services = {
    statePath,
    lane: { artifacts, tracker },
  };
  const call = async (args: string[]) => {
    const output: string[] = [];
    const code = await runCli([...args, "--json"], (text) => output.push(text), services);
    return { code, value: JSON.parse(output.join("\n")) };
  };
  try {
    const id = (await call(["lane", "create", "--ticket", String(ticket)])).value.value.id;
    await call(["lane", "claim", id, "--run", runRef, "--claim", "interlock-claim:submit"]);
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
    const { service, artifacts, cleanup } = await setup({ tracker });
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
    const { service, cleanup } = await setup({ tracker });
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
    host: adapterRefSchema.parse("t3"),
    harness: adapterRefSchema.parse("t3"),
    workspace: { path: directory, branch },
    capabilities: {},
    status: "claimed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await seedClaim(seed, directory);
  seed.close();
  const call = async (args: string[]) => {
    const output: string[] = [];
    const code = await runCli([...args, "--json"], (text) => output.push(text), services);
    return { code, value: JSON.parse(output.join("\n")) };
  };
  const id = (await call(["lane", "create", "--ticket", jiraTicket])).value.value.id;
  await call(["lane", "claim", id, "--run", runRef, "--claim", "interlock-claim:submit"]);
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
      lane: { artifacts: new FakeArtifacts() },
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

test("tracker failure retains the PR identity before a retry after closure", async () => {
  const tracker = new LinkingTracker();
  tracker.failWith = new Error("403");
  const { service, store, artifacts, cleanup } = await setup({ tracker });
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
    const { service, artifacts, cleanup } = await setup({ branch });
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
    const first = await setup();
    try {
      const id = await implementing(first.service);
      await first.service.submit(id, { head: "abc", evidence: evidence("abc"), title });
      expect(first.artifacts.opens[0]?.title).toBe(`JWB-878: ${title}`);
    } finally {
      first.cleanup();
    }
  }
  for (const title of ["Unrelated feature", "JWB-8780: other", "X_JWB-878: other"]) {
    const { service, artifacts, cleanup } = await setup();
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

for (const states of [
  ["CLOSED"],
  ["MERGED"],
  ["OPEN", "OPEN"],
  ["OPEN", "CLOSED"],
  ["OPEN", "MERGED"],
] as const) {
  test(`submit refuses branch PR candidates in states ${states.join(", ")}`, async () => {
    const { service, artifacts, cleanup } = await setup();
    try {
      artifacts.open_ = states.map((state, index) => ({
        url: `https://github.com/o/r/pull/${index + 1}`,
        branch,
        title: "JWB-878: existing",
        state,
      }));
      const id = await implementing(service);
      expect(await service.submit(id, { head: "abc", evidence: evidence("abc") })).toMatchObject({
        ok: false,
        refusal: { code: states.length > 1 ? "duplicate_artifact" : "artifact_mismatch" },
      });
      expect(artifacts.pushes).toEqual([]);
      expect(artifacts.opens).toEqual([]);
    } finally {
      cleanup();
    }
  });
}

for (const invalid of [
  "run_status",
  "claim_status",
  "run_ticket",
  "claim_ticket",
  "claim_run",
  "claim_home",
  "missing_home",
  "workspace_path",
  "workspace_branch",
] as const) {
  test(`submit verifies active local ownership and workspace: ${invalid}`, async () => {
    const { service, store, artifacts, claim, cleanup } = await setup();
    try {
      const id = await implementing(service);
      const run = store.run(runRef);
      if (invalid === "run_status") store.saveRun({ ...run, status: "released" });
      if (invalid === "claim_status") store.saveClaim({ ...claim, status: "released" });
      if (invalid === "run_ticket")
        store.run = () => ({ ...run, ticket: ticketRefSchema.parse("jira:x:W:ticket:JWB-999") });
      if (invalid === "claim_ticket")
        store.claim = () => ({
          ...claim,
          ticket: ticketRefSchema.parse("jira:x:W:ticket:JWB-999"),
        });
      if (invalid === "claim_run")
        store.claim = () => ({ ...claim, run: runRefSchema.parse("interlock-run:other") });
      if (invalid === "claim_home")
        store.saveClaim({ ...claim, claimHome: "github.com/wrong/home" });
      if (invalid === "missing_home") store.saveClaim({ ...claim, claimHome: "" });
      if (invalid === "workspace_path" || invalid === "workspace_branch") {
        artifacts.prepare = async (workspace, head) => ({
          ...workspace,
          ...(invalid === "workspace_path" ? { path: "/other" } : { branch: "other/JWB-878" }),
          head,
          repository: "github.com/o/r",
          remote: "https://github.com/o/r.git",
        });
      }
      expect(await service.submit(id, { head: "abc", evidence: evidence("abc") })).toMatchObject({
        ok: false,
        refusal: { code: "claim_collision" },
      });
      expect(artifacts.pushes).toEqual([]);
      expect(artifacts.opens).toEqual([]);
    } finally {
      cleanup();
    }
  });
}

for (const remote of ["released", "claim", "run", "owner", "unreadable"] as const) {
  test(`submit freshly verifies the remote claim after PR lookup: ${remote}`, async () => {
    const { service, artifacts, store, claim, lock, cleanup } = await setup();
    try {
      const id = await implementing(service);
      artifacts.pullRequests = async () => {
        await lock.release({
          ticket,
          claim: claim.ref,
          authorizedBy: claim.humanOwner,
          expectedVersion: (await lock.read(ticket)).version,
          originalSnapshot: claim.previousState,
        });
        if (remote === "unreadable") rmSync(claim.claimHomeUrl, { recursive: true, force: true });
        else if (remote !== "released")
          await lock.claim({
            ticket,
            claim: remote === "claim" ? claimRefSchema.parse("interlock-claim:other") : claim.ref,
            run: remote === "run" ? runRefSchema.parse("interlock-run:other") : runRef,
            owner: remote === "owner" ? actorRefSchema.parse("other") : claim.humanOwner,
            leaseExpiresAt: claim.leaseExpiresAt,
            expectedVersion: (await lock.read(ticket)).version,
          });
        return [];
      };
      expect(await service.submit(id, { head: "abc", evidence: evidence("abc") })).toMatchObject({
        ok: false,
        refusal: { code: "claim_collision" },
      });
      expect(store.claim(claim.ref).status).toBe("active");
      expect(artifacts.pushes).toEqual([]);
      expect(artifacts.opens).toEqual([]);
    } finally {
      cleanup();
    }
  });
}

test("an ambiguous create adopts its eventual PR after service restart", async () => {
  const fixture = await setup();
  try {
    const id = await implementing(fixture.service);
    fixture.artifacts.openOutcome = "failed";
    await fixture.service.submit(id, { head: "abc", evidence: evidence("abc") });
    const restarted = new LaneService({
      store: fixture.store,
      artifacts: fixture.artifacts,
      ...(fixture.tracker ? { tracker: fixture.tracker } : {}),
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
