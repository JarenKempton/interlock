import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpTransport } from "../src/adapters/trackers/http.ts";
import { jiraApiToken } from "../src/adapters/trackers/jira-sign-in.ts";
import type { CommandResult, GitCommandExecutor } from "../src/adapters/workspaces/git.ts";
import { run } from "../src/cli.ts";
import { executionTracker } from "../src/execution/pickup-runtime.ts";
import { type CredentialStore, osCredentialStore } from "../src/persistence/credential-store.ts";
import { StateStore } from "../src/persistence/state.ts";
import type { RuntimeServices } from "../src/runtime-services.ts";
import { lineInput, type Terminal } from "../src/sign-in/terminal.ts";

const TOKEN = `ATATT3x${"A".repeat(176)}=0A1B2C3D`;
const SITE = "https://example.atlassian.net";
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

class FakeStore implements CredentialStore {
  entries = new Map<string, string>();
  async read(name: string) {
    return this.entries.get(name);
  }
  async write(name: string, secret: string) {
    this.entries.set(name, secret);
  }
  async delete(name: string) {
    this.entries.delete(name);
  }
}

function fakeJira(granted: string[] = ["BROWSE_PROJECTS", "TRANSITION_ISSUES", "ASSIGN_ISSUES"]) {
  const calls: string[] = [];
  const http: HttpTransport = async (url, request = {}) => {
    calls.push(url);
    const authorized =
      request.headers?.Authorization === `Basic ${btoa(`lane@example.com:${TOKEN}`)}` ||
      request.headers?.Authorization === `Basic ${btoa("ci@example.com:ci-token")}`;
    if (!authorized) return new Response(null, { status: 401 });
    const path = new URL(url).pathname;
    if (path === "/rest/api/3/myself")
      return Response.json({ accountId: "account-1", displayName: "Lane Person" });
    if (path === "/rest/api/3/mypermissions")
      return Response.json({
        permissions: Object.fromEntries(
          ["BROWSE_PROJECTS", "TRANSITION_ISSUES", "ASSIGN_ISSUES", "EDIT_ISSUES"].map((key) => [
            key,
            { havePermission: granted.includes(key) },
          ]),
        ),
      });
    return new Response(null, { status: 404 });
  };
  return { http, calls };
}

function fakeTerminal(answers: string[], interactive = true) {
  const asked: Array<{ label: string; hidden: boolean }> = [];
  const said: string[] = [];
  const opened: string[] = [];
  const terminal: Terminal = {
    interactive: () => interactive,
    say: (text) => said.push(text),
    async ask(label, options) {
      asked.push({ label, hidden: options.hidden });
      return answers.shift() || options.default || "";
    },
    open: (url) => opened.push(url),
  };
  return { terminal, asked, said, opened };
}

function fakeGit(push: number): GitCommandExecutor & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(argv): Promise<CommandResult> {
      calls.push([...argv]);
      if (argv[1] === "rev-parse") return { exitCode: 0, stdout: "/work/repo\n", stderr: "" };
      if (argv[1] === "push") return { exitCode: push, stdout: "", stderr: "denied" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function harness(
  options: {
    answers?: string[];
    interactive?: boolean;
    environment?: Record<string, string>;
    granted?: string[];
    push?: number;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "interlock-sign-in-"));
  directories.push(directory);
  const store = new FakeStore();
  const jira = fakeJira(options.granted);
  const terminal = fakeTerminal(options.answers ?? [], options.interactive);
  const git = fakeGit(options.push ?? 0);
  const statePath = join(directory, "state.db");
  const services: RuntimeServices = {
    statePath,
    configuration: { cwd: directory, statePath },
    execution: { git },
    signIn: {
      credentials: store,
      terminal: terminal.terminal,
      http: jira.http,
      environment: options.environment ?? {},
    },
  };
  const output: string[] = [];
  const cli = (...args: string[]) => run(args, (line) => output.push(line), services);
  const configPath = join(realpathSync(directory), "interlock.toml");
  return { services, store, jira, terminal, git, statePath, configPath, output, cli };
}

function userSettings(statePath: string) {
  const store = new StateStore(statePath);
  try {
    return store.userSettings();
  } finally {
    store.close();
  }
}

async function doctor(subject: ReturnType<typeof harness>, ...args: string[]) {
  subject.output.length = 0;
  await subject.cli("doctor", "--json", ...args);
  return JSON.parse(subject.output.join("\n"));
}

test("Jira tokens lose trailing paste junk and terminal escape sequences", () => {
  expect(TOKEN).toHaveLength(192);
  expect(jiraApiToken(`  ${TOKEN}~]x\n`)).toBe(TOKEN);
  expect(jiraApiToken(`${TOKEN}abc`)).toBe(TOKEN);
  expect(jiraApiToken("short-token")).toBe("short-token");
  expect(jiraApiToken(`${TOKEN}=deadbeef`)).toBe(TOKEN);
  const afterReturn = lineInput(undefined, true);
  expect(afterReturn.feed("\nnext\r")).toMatchObject({ state: "done", afterReturn: true });
  expect(afterReturn.value()).toBe("next");
  const stuck = lineInput();
  stuck.feed("\u001b[20");
  expect(stuck.feed("\u0003")).toEqual({ state: "cancelled", rest: "" });
  const input = lineInput();
  expect(input.feed(`\u001b[200~${TOKEN}x\u007f\u001b[201~`)).toBeUndefined();
  expect(input.feed("\r\nnext-line\r")).toMatchObject({ state: "done", rest: "next-line\r" });
  expect(input.value()).toBe(TOKEN);
  expect(lineInput().feed("\u0003")).toEqual({ state: "cancelled", rest: "" });
  const split = lineInput();
  split.feed("\u001b[20");
  split.feed(`0~${TOKEN}\u001b`);
  split.feed("[201~");
  expect(split.feed("\r")).toMatchObject({ state: "done", rest: "" });
  expect(split.value()).toBe(TOKEN);
  const echoed: string[] = [];
  const visible = lineInput((text) => echoed.push(text));
  visible.feed("ab\u007f\r");
  expect(echoed.join("")).toBe("ab\b \b");
});

test("login asks for the site, opens the token page, verifies, stores, and prints the name", async () => {
  const subject = harness({
    answers: ["example.atlassian.net", "lane@example.com", `${TOKEN}~]x`],
  });
  await subject.cli("login", "jira");
  expect(subject.output).toEqual([`Signed in to Jira at ${SITE} as Lane Person.`]);
  expect(subject.terminal.asked).toEqual([
    { label: "Jira site", hidden: false },
    { label: "Atlassian email", hidden: false },
    { label: "Atlassian API token", hidden: true },
  ]);
  expect(subject.terminal.opened).toEqual([
    "https://id.atlassian.com/manage-profile/security/api-tokens",
  ]);
  expect(subject.jira.calls).toEqual([`${SITE}/rest/api/3/myself`]);
  expect(JSON.parse(subject.store.entries.get("jira:example.atlassian.net") ?? "")).toEqual({
    email: "lane@example.com",
    token: TOKEN,
  });
  expect(userSettings(subject.statePath)).toEqual({ jira_site: SITE });
  expect(readFileSync(subject.statePath).includes(TOKEN.slice(0, 40))).toBe(false);
});

test("a rejected token stores nothing and saves no site", async () => {
  const subject = harness({ answers: [SITE, "lane@example.com", "wrong-token"] });
  await expect(subject.cli("login", "jira")).rejects.toThrow(
    "Jira rejected the email or API token (401)",
  );
  expect(subject.store.entries.size).toBe(0);
  expect(userSettings(subject.statePath)).toEqual({});
});

test("login without a terminal names the headless environment variables", async () => {
  const subject = harness({ interactive: false });
  await expect(subject.cli("login", "jira")).rejects.toThrow(
    "set JIRA_SITE, JIRA_USER_EMAIL, JIRA_API_TOKEN for headless use",
  );
});

test("logout removes the stored credentials and keeps the saved site", async () => {
  const subject = harness({ answers: [SITE, "lane@example.com", TOKEN] });
  await subject.cli("login", "jira");
  subject.output.length = 0;
  await subject.cli("logout", "jira");
  expect(subject.output).toEqual([`Signed out of Jira at ${SITE}.`]);
  expect(subject.store.entries.size).toBe(0);
  expect(userSettings(subject.statePath)).toEqual({ jira_site: SITE });
  expect((await doctor(subject)).missing).toEqual([
    `Jira credentials for ${SITE}: run interlock login jira or set JIRA_USER_EMAIL and JIRA_API_TOKEN`,
  ]);
});

test("doctor names the missing sign-in, Jira permissions, and claim-lock push access", async () => {
  const signedOut = harness({ push: 128 });
  expect(await doctor(signedOut)).toMatchObject({
    ok: false,
    jira: { site: null, signedIn: false },
    claimLock: { repository: "/work/repo", dryRunPush: false },
    missing: [
      "Jira sign-in: run interlock login jira",
      "Git claim lock: origin refuses a dry-run push from /work/repo",
    ],
  });
  expect(signedOut.git.calls.at(-1)).toEqual([
    "git",
    "push",
    "--dry-run",
    "--porcelain",
    "origin",
    "HEAD:refs/interlock/v2/doctor",
  ]);

  const signedIn = harness({ answers: [SITE, "lane@example.com", TOKEN] });
  await signedIn.cli("login", "jira");
  expect(await doctor(signedIn, "--project", "JWB")).toMatchObject({
    ok: false,
    jira: {
      site: SITE,
      signedIn: true,
      account: "Lane Person",
      from: ["credential store"],
      permissions: { project: "JWB" },
    },
    claimLock: { dryRunPush: true },
    missing: ["Jira permission Edit issues (issue properties) (EDIT_ISSUES) in JWB"],
  });
  expect(signedIn.jira.calls.at(-1)).toContain("projectKey=JWB");
});

test("environment variables bypass the store and need no login or project config", async () => {
  const subject = harness({
    environment: {
      JIRA_SITE: "example.atlassian.net",
      JIRA_USER_EMAIL: "ci@example.com",
      JIRA_API_TOKEN: "ci-token",
    },
    granted: ["BROWSE_PROJECTS", "TRANSITION_ISSUES", "ASSIGN_ISSUES", "EDIT_ISSUES"],
  });
  subject.store.read = async () => {
    throw new Error("Linux Secret Service (secret-tool) is unavailable");
  };
  expect(await doctor(subject)).toMatchObject({
    ok: true,
    jira: { signedIn: true, from: ["environment"] },
    missing: [],
  });
  const tracker = await executionTracker(SITE, "JWB", subject.services, "release");
  expect(String(tracker.owner)).toBe("account-1");
});

test("pickup refuses to reach Jira before sign-in", async () => {
  const subject = harness();
  await expect(executionTracker(SITE, "JWB", subject.services, "release")).rejects.toThrow(
    `Not signed in to Jira at ${SITE}; run interlock login jira or set JIRA_USER_EMAIL and JIRA_API_TOKEN`,
  );
  expect(subject.jira.calls).toEqual([]);
});

test.skipIf(process.env.INTERLOCK_TEST_OS_CREDENTIAL_STORE !== "1")(
  "the OS credential store round-trips and deletes a secret",
  async () => {
    const store = osCredentialStore(`interlock-test-${process.pid}`);
    const name = "jira:example.atlassian.net";
    const secret = JSON.stringify({ email: "jörg@example.com", token: TOKEN });
    try {
      await store.write(name, secret);
      expect(await store.read(name)).toBe(secret);
    } finally {
      await store.delete(name);
    }
    expect(await store.read(name)).toBeUndefined();
  },
  30_000,
);

test("a failed permission check keeps the verified sign-in", async () => {
  const subject = harness({ answers: [SITE, "lane@example.com", TOKEN] });
  await subject.cli("login", "jira");
  const http = subject.jira.http;
  subject.services.signIn = {
    ...subject.services.signIn,
    http: async (url, request) =>
      url.includes("mypermissions") ? new Response(null, { status: 403 }) : http(url, request),
  };
  expect(await doctor(subject)).toMatchObject({
    jira: { signedIn: true, account: "Lane Person" },
    missing: [`Jira permission check at ${SITE}: Jira permission check failed (403)`],
  });
});

test("doctor prints one line per check when everything is ready", async () => {
  const subject = harness({
    answers: [SITE, "lane@example.com", TOKEN],
    granted: ["BROWSE_PROJECTS", "TRANSITION_ISSUES", "ASSIGN_ISSUES", "EDIT_ISSUES"],
  });
  await subject.cli("login", "jira");
  subject.output.length = 0;
  expect(await subject.cli("doctor", "--project", "JWB")).toBe(0);
  expect(subject.output.join("\n").split("\n")).toEqual([
    `✓ Jira signed in at ${SITE} as Lane Person (credential store)`,
    "✓ Jira permissions in JWB: browse, transition, assign, edit issue properties",
    "✓ Claim lock dry-run push to origin from /work/repo",
    `✓ Database ${subject.statePath}`,
    `✓ Config ${subject.configPath} (not found)`,
  ]);
});

test("doctor follows each failing check with its fix", async () => {
  const subject = harness({ push: 128 });
  await subject.cli("doctor", "--project", "JWB");
  expect(subject.output.join("\n").split("\n")).toEqual([
    "✗ Jira not signed in",
    "  → Jira sign-in: run interlock login jira",
    "✗ Jira permissions not checked",
    "  → sign in first: run interlock login jira",
    "✗ Claim lock dry-run push failed",
    "  → Git claim lock: origin refuses a dry-run push from /work/repo",
    `✓ Database ${subject.statePath}`,
    `✓ Config ${subject.configPath} (not found)`,
  ]);
});

test("doctor exits 1 when any check fails, with or without --json", async () => {
  const subject = harness();
  expect(await subject.cli("doctor")).toBe(1);
  expect(await subject.cli("doctor", "--json")).toBe(1);
});

test("a site that is not a full https origin is refused before any prompt for secrets or Jira call", async () => {
  for (const site of [
    "h",
    "https://h",
    "https://responsibid.atlassian.net/br",
    "http://x.atlassian.net",
  ]) {
    const subject = harness({ answers: [site, "lane@example.com", TOKEN] });
    await expect(subject.cli("login", "jira")).rejects.toThrow(
      "Jira site must be an https site origin such as https://example.atlassian.net",
    );
    expect(subject.terminal.asked).toEqual([{ label: "Jira site", hidden: false }]);
    expect(subject.jira.calls).toEqual([]);
    expect(subject.store.entries.size).toBe(0);
    expect(userSettings(subject.statePath)).toEqual({});
  }
});
