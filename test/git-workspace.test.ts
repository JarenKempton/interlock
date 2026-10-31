import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  type GitCommandExecutor,
  GitWorkspaceAdapter,
  normalizeGitRemote,
  type PreparedGitWorkspace,
  parseWorktrees,
  WorkspaceConflictError,
  type WorkspaceFileSystem,
} from "../src/adapters/workspaces/git.ts";
import { mapRefSchema, ticketRefSchema } from "../src/domain/identifiers.ts";
import type { RepositorySpec, Ticket } from "../src/domain/model.ts";

class FakeGit implements GitCommandExecutor {
  readonly calls: { argv: readonly string[]; cwd: string }[] = [];
  worktrees = "";
  branchExists = false;
  fetchFails = false;
  remote = "git@example.test:team/repo.git";

  async run(argv: readonly string[], cwd: string) {
    this.calls.push({ argv, cwd });
    const command = argv.join(" ");
    if (command === "git rev-parse --show-toplevel") return ok(cwd);
    if (command === "git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main")
      return this.fetchFails ? fail("could not read from remote") : ok("");
    if (command === "git rev-parse --verify refs/remotes/origin/main^{commit}") return ok("abc");
    if (command === "git remote get-url origin") return ok(this.remote);
    if (command === "git worktree list --porcelain") return ok(this.worktrees);
    if (command.startsWith("git show-ref")) return this.branchExists ? ok("") : fail();
    if (command.startsWith("git worktree add")) {
      const path = argv.at(-2);
      const branch = this.branchExists ? argv.at(-1) : argv.at(-3);
      this.worktrees = `worktree ${path}\nbranch refs/heads/${branch}\n`;
      return ok("");
    }
    return fail("unexpected command");
  }
}

class FakeFileSystem implements WorkspaceFileSystem {
  async lock() {
    return () => {};
  }
  existing = new Set<string>();

  async exists(path: string) {
    return this.existing.has(path);
  }
}

const repository: RepositorySpec = {
  name: "repo",
  remote: "git@example.test:team/repo.git",
  path: "/source/repo",
  worktreeRoot: "/worktrees",
  baseBranch: "main",
};
const repositoryPath = resolve(repository.path);
const ticket: Ticket = {
  ref: ticketRefSchema.parse("jira:example:TEAM:ticket:ABC-123"),
  map: mapRefSchema.parse("jira:example:TEAM:map:ABC-1"),
  kind: "task",
  state: "open",
  status: "To Do",
  order: 0,
};
const worktreePath = resolve(repository.worktreeRoot, "ABC-123");
const branch = "task/ABC-123";

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}
function fail(stderr = "not found") {
  return { exitCode: 1, stdout: "", stderr };
}
function subject(git = new FakeGit(), fileSystem = new FakeFileSystem()) {
  return { git, fileSystem, workspace: new GitWorkspaceAdapter(repository, git, fileSystem) };
}
function record(path = worktreePath, recordBranch = branch) {
  return `worktree ${path}\nbranch refs/heads/${recordBranch}\n`;
}
async function preparedWorkspace(workspace: GitWorkspaceAdapter): Promise<PreparedGitWorkspace> {
  return workspace.prepare(await workspace.plan(ticket));
}

describe("Git workspace adapter", () => {
  test("maps the ticket key to canonical native path and branch", async () => {
    const { workspace } = subject();
    expect(await workspace.plan(ticket)).toEqual({
      ticket: ticket.ref,
      path: worktreePath,
      branch,
    });
  });

  test("rejects tampered paths and branches before any Git mutation or read", async () => {
    const pathCase = subject();
    const canonical = await pathCase.workspace.plan(ticket);
    await expect(
      pathCase.workspace.prepare({ ...canonical, path: resolve("/attacker/worktree") }),
    ).rejects.toBeInstanceOf(WorkspaceConflictError);
    expect(pathCase.git.calls).toHaveLength(0);

    const branchCase = subject();
    await expect(
      branchCase.workspace.prepare({ ...canonical, branch: "task/attacker" }),
    ).rejects.toBeInstanceOf(WorkspaceConflictError);
    expect(branchCase.git.calls).toHaveLength(0);
  });

  test("preflight accepts equivalent SSH, HTTPS, and scp-style remotes", async () => {
    const equivalents = [
      "git@example.test:team/repo.git",
      "ssh://git@example.test/team/repo.git",
      "https://example.test/team/repo.git",
    ];
    for (const remote of equivalents) {
      const candidate = subject();
      candidate.git.remote = remote;
      await candidate.workspace.preflight(ticket);
    }
    expect(normalizeGitRemote("ssh://git@EXAMPLE.test:22/team/repo.git")).toBe(
      "example.test/team/repo",
    );
  });

  test("preflight rejects a different remote repository", async () => {
    const { workspace, git } = subject();
    git.remote = "https://example.test/team/other.git";
    await expect(workspace.preflight(ticket)).rejects.toBeInstanceOf(WorkspaceConflictError);
  });

  test("resumes an exact registered worktree without mutating dirty work", async () => {
    const candidate = subject();
    candidate.fileSystem.existing.add(worktreePath);
    candidate.git.worktrees = record();
    expect(await preparedWorkspace(candidate.workspace)).toEqual({
      ticket: ticket.ref,
      path: worktreePath,
      branch,
    });
    expect(candidate.git.calls).toHaveLength(1);
  });

  test("rejects missing, prunable, duplicate, detached, and conflicting worktrees", async () => {
    const missing = subject();
    missing.git.worktrees = record();
    await expect(preparedWorkspace(missing.workspace)).rejects.toBeInstanceOf(
      WorkspaceConflictError,
    );

    const prunable = subject();
    prunable.fileSystem.existing.add(worktreePath);
    prunable.git.worktrees = `${record()}prunable stale gitdir\n`;
    await expect(preparedWorkspace(prunable.workspace)).rejects.toBeInstanceOf(
      WorkspaceConflictError,
    );

    const duplicate = subject();
    duplicate.git.worktrees = `${record()}\n${record()}`;
    await expect(preparedWorkspace(duplicate.workspace)).rejects.toBeInstanceOf(
      WorkspaceConflictError,
    );

    const detached = subject();
    detached.fileSystem.existing.add(worktreePath);
    detached.git.worktrees = `worktree ${worktreePath}\ndetached\n`;
    await expect(preparedWorkspace(detached.workspace)).rejects.toBeInstanceOf(
      WorkspaceConflictError,
    );

    const branchElsewhere = subject();
    branchElsewhere.git.worktrees = record(resolve("/somewhere/else"));
    await expect(preparedWorkspace(branchElsewhere.workspace)).rejects.toBeInstanceOf(
      WorkspaceConflictError,
    );
  });

  test("creates and verifies new or existing canonical branches", async () => {
    const created = subject();
    expect(await preparedWorkspace(created.workspace)).toEqual({
      ticket: ticket.ref,
      path: worktreePath,
      branch,
    });
    expect(created.git.calls).toContainEqual({
      argv: [
        "git",
        "worktree",
        "add",
        "--no-track",
        "-b",
        branch,
        worktreePath,
        "refs/remotes/origin/main",
      ],
      cwd: repositoryPath,
    });

    const existing = subject();
    existing.git.branchExists = true;
    await preparedWorkspace(existing.workspace);
    expect(existing.git.calls).toContainEqual({
      argv: ["git", "worktree", "add", worktreePath, branch],
      cwd: repositoryPath,
    });
  });

  test("refreshBase fetches the origin base and fails closed before any worktree when it cannot", async () => {
    const readOnly = subject();
    await readOnly.workspace.preflight(ticket);
    expect(readOnly.git.calls.some((call) => call.argv[1] === "fetch")).toBeFalse();
    const fetched = subject();
    await fetched.workspace.refreshBase();
    expect(fetched.git.calls.map((call) => call.argv.join(" "))).toContain(
      "git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main",
    );
    const offline = subject();
    offline.git.fetchFails = true;
    await expect(offline.workspace.refreshBase()).rejects.toThrow("Cannot fetch main from origin");
    expect(offline.git.calls.some((call) => call.argv[1] === "worktree")).toBeFalse();
  });

  test("parses CRLF porcelain output and retains prunable metadata", () => {
    const nativePath = "C:\\Users\\Jaren\\Interlock Worktrees\\ABC-123";
    expect(
      parseWorktrees(
        `worktree ${nativePath}\r\nbranch refs/heads/${branch}\r\nprunable stale gitdir\r\n`,
      ),
    ).toEqual([{ path: resolve(nativePath), branch, prunable: "stale gitdir" }]);
  });

  test("passes a native path containing spaces as one argv element", async () => {
    const git = new FakeGit();
    const workspace = new GitWorkspaceAdapter(
      { ...repository, worktreeRoot: "/work trees" },
      git,
      new FakeFileSystem(),
    );
    const plan = await workspace.plan(ticket);
    await workspace.prepare(plan);
    expect(git.calls.some((call) => call.argv.includes(plan.path))).toBeTrue();
  });
});
