import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkspaceAdapter, WorkspacePlan } from "../../domain/contracts.ts";
import type { PreparedWorkspace, RepositorySpec, Ticket, TicketRef } from "../../domain/model.ts";
import { parseRef } from "../../domain/reference.ts";
import type {
  MergeProof,
  RetirementIdentity,
  RetirementPhase,
  RetirementRecord,
} from "../../domain/retirement.ts";
import { lockExecution } from "../../persistence/execution-lock.ts";
import { GitRetirement } from "./retirement.ts";

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
  lock(repository: string, git: GitCommandExecutor): Promise<() => void>;
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
  async lock(repository, git) {
    const result = await git.run(
      ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
      repository,
    );
    if (result.exitCode !== 0)
      throw new WorkspaceConflictError("Cannot determine workspace lifecycle lock");
    return lockExecution(join(result.stdout.trim(), "config"));
  },
};

/** Git-backed workspaces with deterministic paths and fail-closed resumption. */
export class GitWorkspaceAdapter implements WorkspaceAdapter {
  readonly #repository: RepositorySpec;
  readonly #git: GitCommandExecutor;
  readonly #fileSystem: WorkspaceFileSystem;
  readonly #branch: (key: string) => string;

  constructor(
    repository: RepositorySpec,
    git: GitCommandExecutor = new BunGitCommandExecutor(),
    fileSystem: WorkspaceFileSystem = nativeFileSystem,
    branch: (key: string) => string = (key) => `task/${key}`,
  ) {
    this.#repository = canonicalRepository(repository);
    this.#git = git;
    this.#fileSystem = fileSystem;
    this.#branch = branch;
  }

  static prepareRetirement(
    identity: RetirementIdentity,
    proof: MergeProof,
    git: GitCommandExecutor = new BunGitCommandExecutor(),
  ) {
    return new GitRetirement(git).prepare(identity, proof);
  }

  static retire(
    record: RetirementRecord,
    advance: (phase: RetirementPhase) => void,
    fence: () => Promise<void>,
    git: GitCommandExecutor = new BunGitCommandExecutor(),
  ) {
    return new GitRetirement(git).retire(record, advance, fence);
  }

  async preflight(ticket: Ticket): Promise<void> {
    workspaceIdentity(ticket.ref);
    await this.preflightRepository();
  }

  async refreshBase(): Promise<void> {
    const name = this.#repository.baseBranch;
    const fetched = await this.#runGit([
      "git",
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${name}:${this.#baseRef()}`,
    ]);
    if (fetched.exitCode !== 0)
      throw new WorkspaceConflictError(
        `Cannot fetch ${name} from origin; new branches start from the current origin base: ${fetched.stderr.trim()}`,
      );
    await this.#gitChecked(["git", "rev-parse", "--verify", `${this.#baseRef()}^{commit}`]);
  }

  #baseRef(): string {
    return `refs/remotes/origin/${this.#repository.baseBranch}`;
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
    return canonicalPlan(this.#repository, ticket.ref, this.#branch);
  }

  async prepare(plan: WorkspacePlan): Promise<PreparedGitWorkspace> {
    const unlock = await this.#fileSystem.lock(this.#repository.path, this.#git);
    try {
      return await this.#prepare(plan);
    } finally {
      unlock();
    }
  }

  async #prepare(plan: WorkspacePlan): Promise<PreparedGitWorkspace> {
    const canonical = canonicalPlan(this.#repository, plan.ticket, this.#branch);
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
          "--no-track",
          "-b",
          canonical.branch,
          canonical.path,
          this.#baseRef(),
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

function canonicalPlan(
  repository: RepositorySpec,
  ticket: TicketRef,
  branch: (key: string) => string,
): WorkspacePlan {
  const identity = workspaceIdentity(ticket);
  return {
    ticket,
    path: resolve(repository.worktreeRoot, identity),
    branch: branch(identity),
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
