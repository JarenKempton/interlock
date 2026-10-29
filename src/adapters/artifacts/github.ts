import { tmpdir } from "node:os";
import { z } from "zod";
import { type MergeProof, mergeProofSchema } from "../../domain/retirement.ts";
import type {
  ArtifactHost,
  ArtifactRequest,
  ArtifactWorkspace,
  PullRequest,
} from "../../execution/lane.ts";
import type { GitCommandExecutor } from "../workspaces/git.ts";

const pullRequestsSchema = z.array(
  z.object({ url: z.url(), headRefName: z.string(), title: z.string() }),
);

export class GitHubArtifactHost implements ArtifactHost {
  readonly #commands: GitCommandExecutor;

  constructor(commands: GitCommandExecutor) {
    this.#commands = commands;
  }

  async push(workspace: ArtifactWorkspace, head: string): Promise<void> {
    const result = await this.#commands.run(
      ["git", "push", "--porcelain", "origin", `${head}:refs/heads/${workspace.branch}`],
      workspace.path,
    );
    if (result.exitCode !== 0) throw new Error(`git push exited ${result.exitCode}`);
  }

  async pullRequests(workspace: ArtifactWorkspace, key?: string): Promise<PullRequest[]> {
    const byBranch = await this.#list(workspace, ["--head", workspace.branch]);
    const byKey = key
      ? (await this.#list(workspace, ["--search", `"${key}" in:title`])).filter((item) =>
          item.title.includes(key),
        )
      : [];
    const unique = new Map(
      [...byBranch, ...byKey].map((item) => [
        item.url,
        { url: item.url, branch: item.headRefName, title: item.title },
      ]),
    );
    return [...unique.values()];
  }

  async open(workspace: ArtifactWorkspace, request: ArtifactRequest): Promise<PullRequest> {
    const result = await this.#commands.run(
      [
        "gh",
        "pr",
        "create",
        "--head",
        workspace.branch,
        "--title",
        request.title,
        "--body",
        request.body,
        ...(request.draft ? ["--draft"] : []),
      ],
      workspace.path,
    );
    if (result.exitCode !== 0) throw new Error(`gh pr create exited ${result.exitCode}`);
    const url = z.url().parse(result.stdout.trim().split(/\r?\n/).at(-1)?.trim());
    return { url, branch: workspace.branch, title: request.title };
  }

  async merged(url: string): Promise<MergeProof> {
    const parsed = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(url);
    if (!parsed) throw new Error("Expected a canonical GitHub pull request URL");
    const repository = `${parsed[1]}/${parsed[2]}`;
    const result = await this.#commands.run(
      ["gh", "api", `repos/${repository}/pulls/${parsed[3]}`],
      tmpdir(),
    );
    if (result.exitCode !== 0) throw new Error(`gh api exited ${result.exitCode}`);
    const repo = z.object({ full_name: z.string() });
    const view = z
      .object({
        html_url: z.url(),
        merged: z.boolean(),
        merge_commit_sha: z.string().nullable(),
        head: z.object({ ref: z.string(), sha: z.string(), repo: repo.nullable() }),
        base: z.object({ ref: z.string(), repo }),
      })
      .parse(JSON.parse(result.stdout));
    if (
      view.html_url !== url ||
      view.base.repo.full_name.toLowerCase() !== repository.toLowerCase() ||
      view.head.repo?.full_name.toLowerCase() !== repository.toLowerCase()
    )
      throw new Error("Pull request repository identity mismatch");
    return mergeProofSchema.parse({
      merged: view.merged,
      url,
      repository: `github.com/${repository}`,
      branch: view.head.ref,
      head: view.head.sha,
      base: view.base.ref,
      commit: view.merge_commit_sha,
    });
  }

  async #list(workspace: ArtifactWorkspace, filter: readonly string[]) {
    const result = await this.#commands.run(
      [
        "gh",
        "pr",
        "list",
        "--state",
        "open",
        ...filter,
        "--json",
        "url,headRefName,title",
        "--limit",
        "20",
      ],
      workspace.path,
    );
    if (result.exitCode !== 0) throw new Error(`gh pr list exited ${result.exitCode}`);
    return pullRequestsSchema.parse(JSON.parse(result.stdout));
  }
}
