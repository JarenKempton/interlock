import { z } from "zod";
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
