import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { JiraTransport } from "../../src/adapters/trackers/jira.ts";
import {
  BunGitCommandExecutor,
  type GitCommandExecutor,
} from "../../src/adapters/workspaces/git.ts";
import type { RuntimeServices } from "../../src/runtime-services.ts";
import { checkedGit, gitRemoteFixture } from "./git-remote.ts";

export class PickupJira implements JiraTransport {
  issue = {
    key: "TEST-492",
    fields: {
      summary: "Prepare a real pickup",
      description:
        "PROBLEM\nPickup is missing.\nACCEPTANCE CRITERIA\n- Claim before creating a worktree.\n- Return the T3 launch arguments.",
      updated: "2026-10-22T00:00:00.000Z",
      assignee: z.object({ accountId: z.string() }).nullable().parse(null),
      status: { name: "To Do", statusCategory: { key: "new" } },
      issuetype: { name: "Task" },
      parent: { key: "TEST-470" },
      customfield_rank: "0|a:",
      issuelinks: z.array(z.unknown()).parse([]),
    },
  };
  relatedIssues: PickupJira["issue"][] = [];
  property: unknown = null;
  owner = "test-owner";
  calls: string[] = [];
  fail: ((method: string, path: string, after: boolean) => void) | undefined;
  async request(method: string, path: string, body?: unknown) {
    this.calls.push(`${method} ${path}`);
    this.fail?.(method, path, false);
    let response: { status: number; body?: unknown };
    if (path === "/rest/api/3/field")
      response = {
        status: 200,
        body: [
          { id: "customfield_rank", schema: { custom: "com.pyxis.greenhopper.jira:gh-lexo-rank" } },
        ],
      };
    else if (path === "/rest/api/3/myself")
      response = { status: 200, body: { accountId: this.owner } };
    else if (path === "/rest/api/3/search/jql") {
      const { jql } = z.object({ jql: z.string() }).parse(body);
      const issues = [this.issue, ...this.relatedIssues].filter(
        (issue) => jql === `parent = ${JSON.stringify(issue.fields.parent?.key)} ORDER BY Rank ASC`,
      );
      response = { status: 200, body: { issues, isLast: true } };
    } else if (path.includes("/properties/")) {
      if (method === "PUT") this.property = body;
      if (method === "DELETE") this.property = null;
      response =
        method === "GET"
          ? this.property === null
            ? { status: 404 }
            : { status: 200, body: { value: this.property } }
          : { status: 204 };
    } else if (path.endsWith("/assignee") && method === "PUT") {
      const { accountId } = z.object({ accountId: z.string().nullable() }).parse(body);
      this.issue.fields.assignee = accountId ? { accountId } : null;
      response = { status: 204 };
    } else if (path.endsWith("/transitions")) {
      if (method === "GET")
        response = {
          status: 200,
          body: {
            transitions: [
              { id: "todo", to: { name: "To Do" } },
              { id: "progress", to: { name: "In Progress" } },
            ],
          },
        };
      else {
        const { transition } = z.object({ transition: z.object({ id: z.string() }) }).parse(body);
        this.issue.fields.status.name = transition.id === "progress" ? "In Progress" : "To Do";
        response = { status: 204 };
      }
    } else if (method === "GET" && path.startsWith("/rest/api/3/issue/")) {
      const issue = [this.issue, ...this.relatedIssues].find((issue) =>
        path.startsWith(`/rest/api/3/issue/${issue.key}?`),
      );
      response = issue ? { status: 200, body: structuredClone(issue) } : { status: 404 };
    } else throw new Error(`Unexpected fake Jira operation: ${method} ${path}`);
    this.fail?.(method, path, true);
    return response;
  }
}

export function catalogEnvelope() {
  return {
    host: "t3",
    observedAt: new Date().toISOString(),
    catalog: {
      parentThreadId: "fixture-thread",
      inheritedProviderInstanceId: "codex",
      inheritedModel: "test-model",
      inheritedOptions: [{ id: "reasoningEffort", value: "high" }],
      runtimeMode: "full-access",
      interactionMode: "default",
      features: { threadManagement: true },
      providers: [
        {
          providerInstanceId: "codex",
          driverKind: "codex",
          canRunChildTask: true,
          constraints: [],
          models: [
            { id: "test-model", options: [{ id: "reasoningEffort", values: ["low", "high"] }] },
          ],
        },
      ],
    },
  };
}

export function localOriginGit(
  git: GitCommandExecutor = new BunGitCommandExecutor(),
): GitCommandExecutor {
  return {
    async run(argv, cwd) {
      if (argv.join(" ") === "git remote get-url origin")
        return { exitCode: 0, stdout: "https://github.com/test/pickup.git", stderr: "" };
      return git.run(argv, cwd);
    },
  };
}

export async function pickupFixture() {
  const remote = await gitRemoteFixture();
  const root = await realpath(dirname(remote.alice));
  await checkedGit(
    remote.git,
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    remote.alice,
  );
  await checkedGit(remote.git, ["branch", "-M", "main"], remote.alice);
  await checkedGit(remote.git, ["remote", "add", "origin", remote.remote], remote.alice);
  const config = join(root, "interlock.toml");
  const state = join(root, "state", "runs.db");
  const t3Catalog = join(root, "catalog.json");
  await writeFile(
    config,
    `version = 1
[repositories.test]
github = "test/pickup"
path = "alice"
worktree_root = "worktrees"
base_branch = "main"
[maps.TEST-470]
repository = "test"
claim_status = "In Progress"
available_statuses = ["To Do"]
[tracker.jira]
site = "https://example.atlassian.net"
[t3]
provider = "codex"
model = "test-model"
[roles.reviewers.correctness]
provider = "codex"
model = "test-model"
`,
  );
  await writeFile(t3Catalog, JSON.stringify(catalogEnvelope()));
  const jira = new PickupJira();
  const git = localOriginGit(remote.git);
  const services: RuntimeServices = {
    configuration: { cwd: root },
    statePath: state,
    execution: { jira, git },
  };
  return {
    remote,
    root,
    config,
    state,
    t3Catalog,
    jira,
    git,
    services,
    input: { key: "TEST-492", config, state, "t3-catalog": t3Catalog },
    worktree: join(root, "worktrees", "TEST-492"),
    async saveJira() {
      await writeFile(
        join(root, "jira.json"),
        JSON.stringify({ issue: jira.issue, property: jira.property }),
      );
    },
    async readJira() {
      return JSON.parse(await readFile(join(root, "jira.json"), "utf8"));
    },
    async existingWorkspace() {
      await mkdir(join(root, "worktrees"), { recursive: true });
      await checkedGit(
        remote.git,
        ["worktree", "add", "-b", "task/TEST-492", join(root, "worktrees", "TEST-492"), "main"],
        remote.alice,
      );
      await writeFile(join(root, "worktrees", "TEST-492", "user-work.txt"), "preserve me");
    },
    dispose: remote.dispose,
  };
}
