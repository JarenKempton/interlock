import { createHash } from "node:crypto";
import { mkdir, realpath, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type MergeProof,
  type RetirementIdentity,
  type RetirementPhase,
  type RetirementPlan,
  type RetirementRecord,
  RetirementRefusal,
  retirementPlanSchema,
} from "../../domain/retirement.ts";
import { lockExecution } from "../../persistence/execution-lock.ts";
import { type GitCommandExecutor, normalizeGitRemote, parseWorktrees } from "./git.ts";
import { verifyRemoteDestination } from "./remote.ts";

export class GitRetirement {
  constructor(private readonly git: GitCommandExecutor) {}

  async prepare(identity: RetirementIdentity, proof: MergeProof): Promise<RetirementPlan> {
    const path = await realpath(identity.path);
    const records = parseWorktrees(await this.checked(["worktree", "list", "--porcelain"], path));
    const main = records[0];
    if (!main || (await realpath(main.path)) === path)
      throw new RetirementRefusal("workspace_unknown", "Refusing to retire the main checkout");
    const commonDirectory = await realpath(
      await this.checked(["rev-parse", "--path-format=absolute", "--git-common-dir"], path),
    );
    const worktreeDirectory = await realpath(
      await this.checked(["rev-parse", "--absolute-git-dir"], path),
    );
    if (commonDirectory === worktreeDirectory)
      throw new RetirementRefusal("workspace_unknown", "Workspace is not a linked worktree");
    const plan = retirementPlanSchema.parse({
      ...identity,
      worktreePath: path,
      repositoryPath: await realpath(main.path),
      commonDirectory,
      worktreeDirectory,
      worktreeIdentity: await this.worktreeIdentity(path),
      proof,
      retainedRef: `refs/interlock/retired/${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
      integration: "ancestry",
    });
    await this.repository(plan);
    await this.workspace(plan);
    plan.integration = await this.integration(plan);
    return plan;
  }

  async retire(
    record: RetirementRecord,
    advance: (phase: RetirementPhase) => void,
    fence: () => Promise<void>,
  ): Promise<void> {
    const plan = retirementPlanSchema.parse(record.plan);
    const unlock = lockExecution(join(plan.commonDirectory, "config"));
    try {
      await this.repository(plan);
      if ((await this.integration(plan)) !== plan.integration)
        throw new RetirementRefusal("branch_unmerged", "Recorded integration proof changed");
      await fence();
      await this.retain(plan);
      const branchHead = await this.ref(`refs/heads/${plan.branch}`, plan);
      if (branchHead !== undefined && branchHead !== plan.head)
        throw new RetirementRefusal(
          "workspace_unknown",
          `Branch ${plan.branch} changed; refusing cleanup`,
        );
      let phase = record.phase;
      if (phase === "prepared") {
        await this.preserveAndRemove(plan);
        advance("worktree_removed");
        phase = "worktree_removed";
      }
      if (await exists(plan.worktreePath))
        throw new RetirementRefusal(
          "cleanup_pending",
          `Worktree path ${plan.worktreePath} was recreated; branch ${plan.branch} is left`,
        );
      const records = parseWorktrees(
        await this.checked(["worktree", "list", "--porcelain"], plan.repositoryPath),
      );
      if (records.some((item) => item.branch === plan.branch || item.path === plan.worktreePath))
        throw new RetirementRefusal(
          "cleanup_pending",
          `Branch ${plan.branch} is registered to a worktree; refusing cleanup`,
        );
      if (phase === "worktree_removed") {
        if (branchHead !== undefined) {
          if ((await this.ref(plan.retainedRef, plan)) !== plan.head)
            throw new RetirementRefusal(
              "cleanup_pending",
              "Retained head changed; refusing branch deletion",
            );
          await this.checked(
            [
              "-c",
              `branch.${plan.branch}.remote=.`,
              "-c",
              `branch.${plan.branch}.merge=${plan.retainedRef}`,
              "branch",
              "-d",
              "--",
              plan.branch,
            ],
            plan.repositoryPath,
          );
        }
        advance("branch_removed");
      } else if (branchHead !== undefined) {
        throw new RetirementRefusal(
          "cleanup_pending",
          `Branch ${plan.branch} was recreated; refusing cleanup`,
        );
      }
    } finally {
      unlock();
    }
  }

  private async preserveAndRemove(plan: RetirementPlan): Promise<void> {
    const archive = join(
      plan.commonDirectory,
      "interlock-retired",
      plan.retainedRef.split("/").at(-1) ?? "",
    );
    const staging = join(archive, "worktree");
    const files = join(archive, "files");
    if (await exists(files)) {
      if ((await this.worktreeIdentity(files)) !== plan.worktreeIdentity)
        throw new RetirementRefusal("cleanup_pending", "Preserved directory identity changed");
    } else {
      if (!(await exists(staging))) {
        await this.workspace(plan);
        await mkdir(archive, { recursive: true, mode: 0o700 });
        await this.checked(["worktree", "move", plan.worktreePath, staging], plan.repositoryPath);
      }
      if (
        (await this.worktreeIdentity(staging)) !== plan.worktreeIdentity ||
        (await realpath(await this.checked(["rev-parse", "--absolute-git-dir"], staging))) !==
          plan.worktreeDirectory
      )
        throw new RetirementRefusal("cleanup_pending", "Staged worktree identity changed");
      await rename(staging, files);
    }
    if (await exists(staging))
      throw new RetirementRefusal(
        "cleanup_pending",
        "Private staging path was recreated; refusing removal",
      );
    const records = parseWorktrees(
      await this.checked(["worktree", "list", "--porcelain"], plan.repositoryPath),
    );
    const record = records.find((item) => item.path === staging);
    if (record) {
      if (record.branch !== plan.branch)
        throw new RetirementRefusal("cleanup_pending", "Staged worktree branch changed");
      await this.checked(["worktree", "remove", staging], plan.repositoryPath);
    } else if (await exists(plan.worktreeDirectory)) {
      throw new RetirementRefusal(
        "cleanup_pending",
        "Worktree registration changed; recovery copy preserved",
      );
    }
  }

  private async repository(plan: RetirementPlan): Promise<void> {
    const path = await realpath(plan.repositoryPath);
    const common = await realpath(
      await this.checked(["rev-parse", "--path-format=absolute", "--git-common-dir"], path),
    );
    if (common !== plan.commonDirectory)
      throw new RetirementRefusal("workspace_unknown", "Repository identity changed");
    const origin = await this.checked(["config", "--get", "remote.origin.url"], path);
    await verifyRemoteDestination(this.git, path, origin);
    if (normalizeGitRemote(origin).toLowerCase() !== plan.proof.repository.toLowerCase())
      throw new RetirementRefusal(
        "workspace_unknown",
        "Origin does not match the merged pull request repository",
      );
    if (
      !plan.proof.merged ||
      plan.proof.url !== plan.artifact ||
      plan.proof.head !== plan.head ||
      plan.proof.branch !== plan.branch
    )
      throw new RetirementRefusal(
        "branch_unmerged",
        "Pull request identity does not match the lane",
      );
    await this.checked(["check-ref-format", `refs/heads/${plan.branch}`], path);
    await this.checked(["check-ref-format", `refs/heads/${plan.proof.base}`], path);
  }

  private async workspace(plan: RetirementPlan): Promise<void> {
    const path = await realpath(plan.worktreePath);
    const records = parseWorktrees(
      await this.checked(["worktree", "list", "--porcelain"], plan.repositoryPath),
    );
    const record = records.find((item) => item.path === path);
    if (
      path === (await realpath(plan.repositoryPath)) ||
      !record ||
      record.branch !== plan.branch ||
      record.prunable !== undefined
    )
      throw new RetirementRefusal(
        "workspace_unknown",
        `Worktree ${path} does not belong to ${plan.branch}`,
      );
    if (
      (await realpath(await this.checked(["rev-parse", "--absolute-git-dir"], path))) !==
        plan.worktreeDirectory ||
      (await this.worktreeIdentity(path)) !== plan.worktreeIdentity
    )
      throw new RetirementRefusal("workspace_unknown", "Worktree registration changed");
    if ((await this.checked(["rev-parse", "HEAD"], path)) !== plan.head)
      throw new RetirementRefusal(
        "branch_unmerged",
        `Worktree ${path} has unsubmitted commits; branch ${plan.branch} is left`,
      );
    const flags = await this.checked(["ls-files", "-v", "-z"], path);
    if (
      flags.split("\0").some((entry) => entry && (/^[a-z]/.test(entry) || entry.startsWith("S ")))
    )
      throw new RetirementRefusal(
        "workspace_dirty",
        `Worktree ${path} hides tracked files with index flags; refusing cleanup`,
      );
    if (await this.checked(["status", "--porcelain", "--untracked-files=all", "--ignored"], path))
      throw new RetirementRefusal(
        "workspace_dirty",
        `Worktree ${path} is dirty; ${path} and ${plan.branch} are left`,
      );
  }

  private async integration(plan: RetirementPlan): Promise<"ancestry" | "squash"> {
    const { base, commit } = plan.proof;
    const cwd = plan.repositoryPath;
    if (!commit) throw new RetirementRefusal("branch_unmerged", "Host has no merged commit");
    await this.checked(["fetch", "--no-tags", "origin", `refs/heads/${base}`], cwd);
    const fetched = await this.checked(["rev-parse", "FETCH_HEAD^{commit}"], cwd);
    if (!(await this.ancestor(commit, fetched, cwd)))
      throw new RetirementRefusal(
        "branch_unmerged",
        `Host merge ${commit} is not reachable from fetched ${base}; workspace and branch are left`,
      );
    if (await this.ancestor(plan.head, commit, cwd)) return "ancestry";
    const parents = (await this.checked(["show", "-s", "--format=%P", commit], cwd)).split(" ");
    if (parents.length === 1 && parents[0]) {
      const merged = await this.git.run(
        ["git", "merge-tree", "--write-tree", parents[0], plan.head],
        cwd,
      );
      const tree = await this.checked(["rev-parse", `${commit}^{tree}`], cwd);
      if (merged.exitCode === 0 && merged.stdout.trim() === tree) return "squash";
    }
    throw new RetirementRefusal(
      "branch_unmerged",
      `No ancestry or exact squash integration proof for ${plan.branch}; workspace and branch are left`,
    );
  }

  private async retain(plan: RetirementPlan): Promise<void> {
    const retained = await this.ref(plan.retainedRef, plan);
    if (retained === plan.head) return;
    if (retained !== undefined)
      throw new RetirementRefusal(
        "cleanup_pending",
        "Retirement ref has another head; refusing to overwrite it",
      );
    await this.checked(
      ["update-ref", plan.retainedRef, plan.head, "0".repeat(plan.head.length)],
      plan.repositoryPath,
    );
  }

  private async ref(ref: string, plan: RetirementPlan): Promise<string | undefined> {
    const result = await this.git.run(
      ["git", "show-ref", "--verify", "--hash", ref],
      plan.repositoryPath,
    );
    if (result.exitCode === 0) return result.stdout.trim();
    const exists = await this.git.run(
      ["git", "show-ref", "--verify", "--quiet", ref],
      plan.repositoryPath,
    );
    if (exists.exitCode === 1) return undefined;
    throw new Error(`Cannot read ref ${ref}`);
  }

  private async ancestor(head: string, base: string, cwd: string): Promise<boolean> {
    const result = await this.git.run(["git", "merge-base", "--is-ancestor", head, base], cwd);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(`Cannot verify ancestry of ${head}`);
  }

  private async worktreeIdentity(path: string): Promise<string> {
    const file = await stat(path);
    return `${file.dev}:${file.ino}:${file.birthtimeMs}`;
  }

  private async checked(args: string[], cwd: string): Promise<string> {
    const result = await this.git.run(["git", ...args], cwd);
    if (result.exitCode !== 0)
      throw new Error(`Git ${args[0]} failed (${result.exitCode}): ${result.stderr.trim()}`);
    return result.stdout.trim();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(resolve(path));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
