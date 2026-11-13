import { expect, test } from "bun:test";
import {
  githubInstance,
  githubNamespace,
  githubRepositoryOf,
  issueMapRef,
  issueRef,
} from "../../../../src/adapters/trackers/github/refs.ts";
import {
  GitHubIssuesTracker,
  INTERLOCK_LABEL,
} from "../../../../src/adapters/trackers/github/tracker.ts";
import {
  ghCliTransport,
  parseIncluded,
} from "../../../../src/adapters/trackers/github/transport.ts";
import type { CommandResult } from "../../../../src/adapters/git/workspace.ts";
import { runConformance } from "../../../../src/conformance/runner.ts";
import { trackerConformance } from "../../../../src/conformance/tracker.ts";
import {
  actorRefSchema,
  claimRefSchema,
  runRefSchema,
} from "../../../../src/domain/refs/identifiers.ts";
import type { MirrorClaim } from "../../../../src/domain/tracker/port.ts";
import { FakeGitHub } from "../../../fixtures/github/issues.ts";
import { expectRejection } from "../../../fixtures/assertions/rejection.ts";

const REPO = "octo-org/octo.repo";
const ticket = issueRef(REPO, 7);
const owner = actorRefSchema.parse("octocat");
const claim: MirrorClaim = {
  ticket,
  claim: claimRefSchema.parse("interlock-claim:github"),
  run: runRefSchema.parse("interlock-run:github"),
  owner,
};

function subject(setup: (github: FakeGitHub) => void = () => {}) {
  const github = new FakeGitHub();
  github.add(REPO, 7, { parent: `${REPO}#1` });
  github.add(REPO, 1, { title: "Map" });
  setup(github);
  return { github, adapter: new GitHubIssuesTracker({ transport: github.transport }) };
}

test("GitHub Issues passes the conformance suite at the assignee-only tier", async () => {
  const report = await runConformance(
    trackerConformance(async () => {
      const { github, adapter } = subject();
      const observer = new GitHubIssuesTracker({ transport: github.direct });
      return {
        adapter,
        claim,
        otherOwner: actorRefSchema.parse("hubot"),
        observe: async () => {
          const issue = github.issues.get(`${REPO}#7`);
          return {
            ticket: (await observer.read(ticket)).ticket,
            mirror: issue?.labels.includes(INTERLOCK_LABEL) ? claim : null,
            writes: github.writes,
          };
        },
        changeOwner: async (login) => {
          const issue = github.issues.get(`${REPO}#7`);
          if (issue) issue.assignees = [login];
        },
        loseWriteReadback: () => {
          github.failReadsAfterWrite = true;
        },
      };
    }),
  );
  expect(report.results.filter((result) => !result.ok)).toEqual([]);
  expect(report.results).toHaveLength(6);
  expect(new GitHubIssuesTracker({ transport: new FakeGitHub().transport }).mirror).toBe(
    "assignee_only",
  );
});

test("read maps blocked_by dependencies, dependents and the sub-issue parent across repositories", async () => {
  const { adapter } = subject((github) => {
    github.add("other/repo", 3, { state: "closed" });
    github.add(REPO, 9, { blockedBy: [`${REPO}#7`] });
    const issue = github.issues.get(`${REPO}#7`);
    if (issue) {
      issue.blockedBy = ["other/repo#3"];
      issue.type = "Research";
    }
  });
  const { ticket: read, snapshot } = await adapter.read(ticket);
  expect(read).toMatchObject({
    ref: "github:octo-org.octo.repo:GH:ticket:GH-7",
    map: "github:octo-org.octo.repo:GH:map:GH-1",
    kind: "research",
    title: "Issue 7",
    description: "Body of 7",
    state: "open",
    status: "To Do",
    dependencies: [
      { blocking: "github:other.repo:GH:ticket:GH-3", blocked: ticket, kind: "blocks" },
    ],
    dependents: [
      { blocking: ticket, blocked: "github:octo-org.octo.repo:GH:ticket:GH-9", kind: "blocks" },
    ],
    metadata: { nativeKey: "octo-org/octo.repo#7", url: `https://github.com/${REPO}/issues/7` },
  });
  expect(read.assignee).toBeUndefined();
  expect(snapshot.payload).toEqual({ assignees: [], labeled: false });
  expect((await adapter.read(issueRef("other/repo", 3))).ticket).toMatchObject({
    state: "closed",
    status: "Done",
  });
});

test("listWork reads every sub-issue of the map in full", async () => {
  const { adapter } = subject((github) => {
    github.add(REPO, 8, { parent: `${REPO}#1`, blockedBy: [`${REPO}#7`] });
  });
  const work = await adapter.listWork(issueMapRef(REPO, 1));
  expect(work.map((item) => item.ref)).toEqual([ticket, issueRef(REPO, 8)]);
  expect(work[1]?.dependencies?.[0]?.blocking).toBe(ticket);
});

test("apply labels and assigns, reports In Progress, and validates only an untouched issue", async () => {
  const validated: string[] = [];
  const { github } = subject();
  const adapter = new GitHubIssuesTracker({
    transport: github.transport,
    claimedStatus: "Doing",
    validateClaim: (current) => {
      validated.push(current.ref);
    },
  });
  await adapter.apply(claim);
  expect(github.issues.get(`${REPO}#7`)).toMatchObject({
    assignees: ["octocat"],
    labels: [INTERLOCK_LABEL],
  });
  expect((await adapter.read(ticket)).ticket).toMatchObject({ status: "Doing", assignee: owner });
  const issue = github.issues.get(`${REPO}#7`);
  if (issue) issue.labels = [];
  await adapter.apply(claim);
  expect(validated).toEqual([ticket]);
  expect(issue?.labels).toEqual([INTERLOCK_LABEL]);
});

test("apply refuses a closed issue and a pull request without writing", async () => {
  const closed = subject((github) => {
    const issue = github.issues.get(`${REPO}#7`);
    if (issue) issue.state = "closed";
  });
  await expectRejection(closed.adapter.apply(claim)).toMatchObject({ code: "claim_collision" });
  expect(closed.github.writes).toBe(0);
  const pull = subject((github) => {
    github.add(REPO, 7, { pullRequest: true });
  });
  await expectRejection(pull.adapter.read(ticket)).toThrow("is a pull request, not an issue");
});

test("a failed label write is ambiguous rather than a definite refusal", async () => {
  const { github, adapter } = subject();
  github.fail = (method) => (method === "POST" ? 403 : undefined);
  await expectRejection(adapter.apply(claim)).toMatchObject({ code: "ambiguous_tracker_result" });
});

test("removeMirror drops only the label, keeps the assignee and refuses another assignee", async () => {
  const { github, adapter } = subject();
  await adapter.apply(claim);
  const issue = github.issues.get(`${REPO}#7`);
  if (issue) issue.assignees = ["hubot"];
  await expectRejection(adapter.removeMirror(claim)).toMatchObject({ code: "claim_collision" });
  if (issue) issue.assignees = ["octocat"];
  await adapter.removeMirror(claim);
  expect(issue).toMatchObject({ assignees: ["octocat"], labels: [] });
});

test("complete closes the issue once and verifies it by readback", async () => {
  const { github, adapter } = subject();
  await adapter.complete(ticket);
  expect(github.issues.get(`${REPO}#7`)?.state).toBe("closed");
  expect(github.requests.find((request) => request.method === "PATCH")?.fields).toEqual({
    state: "closed",
    state_reason: "completed",
  });
  const writes = github.writes;
  await adapter.complete(ticket);
  expect(github.writes).toBe(writes);
  const unverified = subject();
  unverified.github.fail = (method) => (method === "PATCH" ? 500 : undefined);
  await expectRejection(unverified.adapter.complete(ticket)).toMatchObject({
    code: "ambiguous_tracker_result",
  });
});

test("linkArtifact comments the pull request link once and verifies it", async () => {
  const { github, adapter } = subject();
  const url = "https://github.com/octo-org/octo.repo/pull/12";
  await adapter.linkArtifact(ticket, url, "GH-7: Fix [things]");
  await adapter.linkArtifact(ticket, url, "GH-7: Fix [things]");
  expect(github.issues.get(`${REPO}#7`)?.comments).toEqual([
    `Linked pull request: [GH-7: Fix things](${url})`,
  ]);
  const lost = subject();
  lost.github.failReadsAfterWrite = true;
  await expectRejection(lost.adapter.linkArtifact(ticket, url)).toMatchObject({
    code: "ambiguous_tracker_result",
  });
});

test("refs round-trip a lowercased OWNER/NAME through the instance and accept only GH keys", () => {
  expect(githubInstance("Octo-Org/Octo.Repo")).toBe("octo-org.octo.repo");
  expect(githubRepositoryOf("octo-org.octo.repo")).toBe("octo-org/octo.repo");
  expect(githubNamespace("GH-12")).toBe("GH");
  expect(githubNamespace("JWB-12")).toBeUndefined();
  expect(githubNamespace("GH-0")).toBeUndefined();
  expect(() => githubInstance("not a repo")).toThrow("OWNER/NAME");
});

test("the gh transport passes fields as -f arguments and reads the included HTTP status", async () => {
  const calls: string[][] = [];
  const transport = ghCliTransport({
    async run(argv): Promise<CommandResult> {
      calls.push([...argv]);
      return {
        exitCode: 1,
        stdout:
          'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"Not Found"}',
        stderr: "gh: Not Found (HTTP 404)",
      };
    },
  });
  expect(
    await transport.request("POST", `repos/${REPO}/issues/7/assignees`, {
      assignees: ["octocat"],
      body: "@file",
    }),
  ).toEqual({ status: 404, body: { message: "Not Found" } });
  expect(calls).toEqual([
    [
      "gh",
      "api",
      "--include",
      "-X",
      "POST",
      `repos/${REPO}/issues/7/assignees`,
      "-f",
      "assignees[]=octocat",
      "-f",
      "body=@file",
    ],
  ]);
  expect(parseIncluded("HTTP/2.0 204 No Content\n\n")).toEqual({ status: 204 });
  expect(parseIncluded("")).toBeUndefined();
  const broken = ghCliTransport({
    run: async () => ({ exitCode: 4, stdout: "", stderr: "not logged in" }),
  });
  await expectRejection(broken.request("GET", "user")).toThrow("gh api exited 4: not logged in");
  await expectRejection(broken.request("GET", "orgs/x")).toThrow("REST path");
});
