import { realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { WorkspaceAdapter, WorkspacePlan } from "../../domain/contracts.ts";
import type { PreparedWorkspace, RepositorySpec, Ticket, TicketRef } from "../../domain/model.ts";
import { parseRef } from "../../domain/reference.ts";
import type { WorkspaceRetirement } from "../../execution/lane.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitCommandExecutor {
  run(argv: readonly string[], cwd: string): Promise<CommandResult>;
}

export interface WorkspaceFileSystem {
  exists(path: string): Promise<boolean>;
}

export interface PreparedGitWorkspace extends PreparedWorkspace {
  ticket: TicketRef;
  branch: string;
}

export class BunGitCommandExecutor implements GitCommandExecutor {
  async run(argv: readonly string[], cwd: string): Promise<CommandResult> {
    const process = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }
}

export class WorkspaceConflictError extends Error {
  readonly code = "workspace_conflict";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceConflictError";
  }
}

interface WorktreeRecord {
  path: string;
  branch?: string;
  prunable?: string;
}

const nativeFileSystem: WorkspaceFileSystem = {
  exists: pathExists,
};

/** Git-backed workspaces with deterministic paths and fail-closed resumption. */
export class GitWorkspaceAdapter implements WorkspaceAdapter {
  readonly #repository: RepositorySpec;
  readonly #git: GitCommandExecutor;
  readonly #fileSystem: WorkspaceFileSystem;

  constructor(
    repository: RepositorySpec,
    git: GitCommandExecutor = new BunGitCommandExecutor(),
    fileSystem: WorkspaceFileSystem = nativeFileSystem,
  ) {
    this.#repository = canonicalRepository(repository);
    this.#git = git;
    this.#fileSystem = fileSystem;
  }

  static async forWorktree(
    path: string,
    baseBranch: string,
    git: GitCommandExecutor = new BunGitCommandExecutor(),
  ): Promise<GitWorkspaceAdapter | undefined> {
    if (!(await pathExists(path))) return undefined;
    const run = async (argv: readonly string[]) => {
      const result = await git.run(argv, path);
      if (result.exitCode !== 0)
        throw new Error(`Git command failed (${result.exitCode}): ${result.stderr.trim()}`);
      return result.stdout.trim();
    };
    const main = parseWorktrees(await run(["git", "worktree", "list", "--porcelain"]))[0];
    if (!main) throw new WorkspaceConflictError(`No main checkout found for ${path}`);
    return new GitWorkspaceAdapter(
      {
        name: "lane",
        remote: await run(["git", "config", "--get", "remote.origin.url"]),
        path: main.path,
        worktreeRoot: dirname(resolve(path)),
        baseBranch,
      },
      git,
    );
  }

  async retire(workspace: { path: string; branch: string }): Promise<WorkspaceRetirement> {
    const path = await realpath(workspace.path).catch(() => resolve(workspace.path));
    const { branch } = workspace;
    if (path === this.#repository.path)
      throw new WorkspaceConflictError(`Refusing to remove the project checkout ${path}`);
    const records = await this.#worktrees();
    const record = records.find((item) => item.path === path);
    if (!record)
      return {
        ok: false,
        code: "workspace_unknown",
        message: `Worktree ${path} is not registered; branch ${branch} is left`,
      };
    if (record.branch !== branch)
      throw new WorkspaceConflictError(
        `Worktree ${path} has ${record.branch ?? "a detached HEAD"}, not ${branch}`,
      );
    const dirty = await this.#git.run(
      ["git", "status", "--porcelain", "--untracked-files=all"],
      path,
    );
    if (dirty.exitCode !== 0) throw new Error(`git status failed in ${path}`);
    if (dirty.stdout.trim())
      return {
        ok: false,
        code: "workspace_dirty",
        message: `Worktree ${path} has uncommitted changes; ${path} and ${branch} are left`,
      };
    const base = this.#repository.baseBranch;
    await this.#gitChecked(["git", "fetch", "--quiet", "origin", base]);
    const upstream = await this.#runGit([
      "git",
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}@{upstream}`,
    ]);
    const deleteReference = upstream.exitCode === 0 ? upstream.stdout.trim() : "HEAD";
    for (const reference of [`refs/remotes/origin/${base}`, deleteReference]) {
      const ancestor = await this.#runGit([
        "git",
        "merge-base",
        "--is-ancestor",
        `refs/heads/${branch}`,
        reference,
      ]);
      if (ancestor.exitCode === 1)
        return {
          ok: false,
          code: "branch_unmerged",
          message: `Branch ${branch} is not merged into ${reference === deleteReference ? `${reference} of ${this.#repository.path}` : `origin/${base}`}; ${path} and ${branch} are left`,
        };
      if (ancestor.exitCode !== 0)
        throw new Error(
          `Git could not compare ${branch} with ${reference}: ${ancestor.stderr.trim()}`,
        );
    }
    await this.#gitChecked(["git", "worktree", "remove", path]);
    await this.#gitChecked(["git", "branch", "-d", branch]);
    return { ok: true };
  }

  async preflight(ticket: Ticket): Promise<void> {
    workspaceIdentity(ticket.ref);
    await this.preflightRepository();
    await this.#gitChecked(["git", "rev-parse", "--verify", this.#repository.baseBranch]);
  }

  async preflightRepository(): Promise<void> {
    const topLevel = resolve(await this.#gitChecked(["git", "rev-parse", "--show-toplevel"]));
    if (topLevel !== this.#repository.path) {
      throw new WorkspaceConflictError(
        `Repository path mismatch: expected ${this.#repository.path}, found ${topLevel}`,
      );
    }
    const actualRemote = (await this.#gitChecked(["git", "remote", "get-url", "origin"])).trim();
    if (normalizeGitRemote(actualRemote) !== normalizeGitRemote(this.#repository.remote)) {
      throw new WorkspaceConflictError(
        `Repository origin mismatch: expected ${this.#repository.remote}, found ${actualRemote}`,
      );
    }
  }

  async plan(ticket: Ticket): Promise<WorkspacePlan> {
    return canonicalPlan(this.#repository, ticket.ref);
  }

  async prepare(plan: WorkspacePlan): Promise<PreparedGitWorkspace> {
    const canonical = canonicalPlan(this.#repository, plan.ticket);
    requireCanonicalPlan(plan, canonical);
    const records = await this.#worktrees();
    const atPath = records.filter((item) => item.path === canonical.path);
    if (atPath.length > 1) {
      throw new WorkspaceConflictError(`Workspace ownership is ambiguous: ${canonical.path}`);
    }
    const existing = atPath[0];
    if (existing) {
      if (existing.prunable !== undefined || !(await this.#fileSystem.exists(canonical.path))) {
        throw new WorkspaceConflictError(
          `Registered workspace is missing or prunable: ${canonical.path}`,
        );
      }
      if (existing.branch !== canonical.branch) {
        throw new WorkspaceConflictError(
          `Workspace path is registered to ${existing.branch ?? "a detached HEAD"}, not ${canonical.branch}`,
        );
      }
      return prepared(canonical);
    }
    const branchElsewhere = records.find((item) => item.branch === canonical.branch);
    if (branchElsewhere) {
      throw new WorkspaceConflictError(
        `Branch ${canonical.branch} is already checked out at ${branchElsewhere.path}`,
      );
    }
    if (await this.#fileSystem.exists(canonical.path)) {
      throw new WorkspaceConflictError(`Unregistered path already exists: ${canonical.path}`);
    }

    const branchExists =
      (
        await this.#runGit([
          "git",
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${canonical.branch}`,
        ])
      ).exitCode === 0;
    const argv = branchExists
      ? ["git", "worktree", "add", canonical.path, canonical.branch]
      : [
          "git",
          "worktree",
          "add",
          "-b",
          canonical.branch,
          canonical.path,
          this.#repository.baseBranch,
        ];
    await this.#gitChecked(argv);

    const created = (await this.#worktrees()).filter((item) => item.path === canonical.path);
    if (
      created.length !== 1 ||
      created[0]?.branch !== canonical.branch ||
      created[0]?.prunable !== undefined
    ) {
      throw new WorkspaceConflictError(
        "Git did not create the requested workspace deterministically",
      );
    }
    return prepared(canonical);
  }

  async #worktrees(): Promise<WorktreeRecord[]> {
    return parseWorktrees(await this.#gitChecked(["git", "worktree", "list", "--porcelain"]));
  }

  #runGit(argv: readonly string[]): Promise<CommandResult> {
    return this.#git.run(argv, this.#repository.path);
  }

  async #gitChecked(argv: readonly string[]): Promise<string> {
    const result = await this.#runGit(argv);
    if (result.exitCode !== 0) {
      throw new Error(`Git command failed (${result.exitCode}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }
}

function canonicalPlan(repository: RepositorySpec, ticket: TicketRef): WorkspacePlan {
  const identity = workspaceIdentity(ticket);
  return {
    ticket,
    path: resolve(repository.worktreeRoot, identity),
    branch: `task/${identity}`,
  };
}

function workspaceIdentity(ticket: TicketRef): string {
  const key = parseRef(ticket).nativeId;
  if (!key || !/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(key))
    throw new WorkspaceConflictError("Workspace requires a canonical ticket key");
  return key;
}

function prepared(plan: WorkspacePlan): PreparedGitWorkspace {
  if (!plan.branch) throw new Error("Canonical Git workspace plan is missing its branch");
  return { ticket: plan.ticket, path: plan.path, branch: plan.branch };
}

function requireCanonicalPlan(
  candidate: Pick<WorkspacePlan, "ticket" | "path" | "branch">,
  canonical: WorkspacePlan,
): void {
  if (
    candidate.ticket !== canonical.ticket ||
    resolve(candidate.path) !== canonical.path ||
    candidate.branch !== canonical.branch
  ) {
    throw new WorkspaceConflictError("Workspace plan does not match its canonical ticket identity");
  }
}

/** Canonical host/path identity shared by SSH, HTTPS, and scp-style Git URLs. */
export function normalizeGitRemote(remote: string): string {
  const value = remote.trim();
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(value);
  if (scp && !value.includes("://")) return remoteIdentity(scp[1] ?? "", scp[2] ?? "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Repository remote is not a supported Git URL: ${remote}`);
  }
  if (url.protocol !== "ssh:" && url.protocol !== "https:") {
    throw new Error(`Repository remote must use SSH or HTTPS: ${remote}`);
  }
  const port =
    (url.protocol === "ssh:" && url.port === "22") ||
    (url.protocol === "https:" && url.port === "443")
      ? ""
      : url.port;
  return remoteIdentity(`${url.hostname}${port ? `:${port}` : ""}`, url.pathname);
}

function remoteIdentity(host: string, path: string): string {
  const normalizedPath = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (!host || !normalizedPath) throw new Error("Repository remote requires a host and path");
  return `${host.toLowerCase()}/${normalizedPath}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error instanceof Error && "code" in error ? error.code : undefined) === "ENOENT")
      return false;
    throw error;
  }
}

function canonicalRepository(repository: RepositorySpec): RepositorySpec {
  if (
    !repository.remote.trim() ||
    !repository.baseBranch.trim() ||
    !repository.path.trim() ||
    !repository.worktreeRoot.trim()
  ) {
    throw new Error("Repository remote, base branch, path, and worktree root are required");
  }
  normalizeGitRemote(repository.remote);
  return {
    ...repository,
    path: resolve(repository.path),
    worktreeRoot: resolve(repository.worktreeRoot),
  };
}

export function parseWorktrees(output: string): WorktreeRecord[] {
  return output
    .split(/\r?\n\r?\n/)
    .map((section) => section.split(/\r?\n/))
    .flatMap((lines) => {
      const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
      if (!path) return [];
      const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice(18);
      const prunable = lines
        .find((line) => line.startsWith("prunable"))
        ?.slice(9)
        .trim();
      return [
        {
          path: resolve(path),
          ...(branch ? { branch } : {}),
          ...(prunable !== undefined ? { prunable } : {}),
        },
      ];
    });
}
