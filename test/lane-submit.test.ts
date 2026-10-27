import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { GitHubArtifactHost } from "../src/adapters/artifacts/github.ts";
import type { JiraTransport } from "../src/adapters/trackers/jira.ts";
import type { CommandResult, GitCommandExecutor } from "../src/adapters/workspaces/git.ts";
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
  type ArtifactWorkspace,
  LaneService,
  type LaneTrackerPort,
  type PullRequest,
} from "../src/execution/lane.ts";
import { StateStore } from "../src/persistence/state.ts";
import type { RuntimeServices } from "../src/runtime-services.ts";

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

  async push(workspace: ArtifactWorkspace, head: string) {
    this.pushes.push({ workspace, head });
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
    const created = { url: prUrl, branch: workspace.branch, title: request.title };
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
  options: { branch?: string; tracker?: LaneTrackerPort | null; artifacts?: boolean } = {},
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
  const artifacts = new FakeArtifacts();
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
    artifacts.open_.push({ url: prUrl, branch });
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
    artifacts.open_.push({ url: "https://github.com/o/r/pull/JWB-878-other", branch: "other" });
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

test("an unverified create is ambiguous_write and a retry opens it once", async () => {
  const { service, artifacts, cleanup } = setup();
  try {
    artifacts.openOutcome = "failed";
    const id = await implementing(service);
    const refused = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(refused).toMatchObject({ ok: false, refusal: { code: "ambiguous_write" } });
    expect(service.get(id)).toMatchObject({ ok: true, value: { state: "implementing" } });
    artifacts.openOutcome = "created";
    const retried = await service.submit(id, { head: "abc", evidence: evidence("abc") });
    expect(retried).toMatchObject({ ok: true, value: { artifact: prUrl } });
    expect(artifacts.open_).toHaveLength(1);
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

class RecordingCommands implements GitCommandExecutor {
  calls: { argv: readonly string[]; cwd: string }[] = [];
  constructor(private readonly respond: (argv: readonly string[]) => CommandResult) {}
  async run(argv: readonly string[], cwd: string) {
    this.calls.push({ argv, cwd });
    return this.respond(argv);
  }
}

test("GitHub host pushes the head to the recorded branch and drives gh with argument arrays", async () => {
  const workspace = { path: "/work/lane", branch };
  const listed = JSON.stringify([
    { url: prUrl, headRefName: branch, title: "JWB-878: core PR" },
    { url: "https://github.com/o/r/pull/9", headRefName: "x", title: "JWB-8780 other" },
  ]);
  const commands = new RecordingCommands((argv) =>
    argv[2] === "create"
      ? { exitCode: 0, stdout: `Creating pull request\n${prUrl}\n`, stderr: "" }
      : { exitCode: 0, stdout: argv[0] === "gh" ? listed : "", stderr: "" },
  );
  const host = new GitHubArtifactHost(commands);
  await host.push(workspace, "abc");
  expect(commands.calls[0]).toEqual({
    argv: ["git", "push", "--porcelain", "origin", `abc:refs/heads/${branch}`],
    cwd: "/work/lane",
  });
  expect(await host.pullRequests(workspace, "JWB-878")).toEqual([
    { url: prUrl, branch, title: "JWB-878: core PR" },
    { url: "https://github.com/o/r/pull/9", branch: "x", title: "JWB-8780 other" },
  ]);
  expect(await host.open(workspace, { title: "JWB-878: t", body: "b", draft: true })).toEqual({
    url: prUrl,
    branch,
    title: "JWB-878: t",
  });
  expect(commands.calls.at(-1)?.argv).toEqual([
    "gh",
    "pr",
    "create",
    "--head",
    branch,
    "--title",
    "JWB-878: t",
    "--body",
    "b",
    "--draft",
  ]);
  const failing = new GitHubArtifactHost(
    new RecordingCommands(() => ({ exitCode: 1, stdout: "", stderr: "denied" })),
  );
  await expect(failing.push(workspace, "abc")).rejects.toThrow("git push exited 1");
  await expect(failing.pullRequests(workspace)).rejects.toThrow("gh pr list exited 1");
  await expect(failing.open(workspace, { title: "t", body: "b", draft: false })).rejects.toThrow(
    "gh pr create exited 1",
  );
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
  const services = { statePath, lane: { artifacts, tracker } };
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
