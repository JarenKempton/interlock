import { z } from "zod";
import { normalizeClaimHome } from "../../domain/claim-home.ts";
import { commitOidSchema, ticketKeyMatches } from "../../domain/submission.ts";
import type {
  ArtifactHost,
  ArtifactRequest,
  ArtifactTarget,
  ArtifactWorkspace,
  PullRequest,
} from "../../execution/lane.ts";
import type { GitCommandExecutor } from "../workspaces/git.ts";
import { checkedGitCommand, verifyRemoteDestination } from "../workspaces/remote.ts";

const pullRequestSchema = z.object({
  url: z.url(),
  headRefName: z.string(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
});
const fields = "url,headRefName,title,state";

export class GitHubArtifactHost implements ArtifactHost {
  constructor(private readonly commands: GitCommandExecutor) {}

  async prepare(workspace: ArtifactWorkspace, head: string): Promise<ArtifactTarget> {
    commitOidSchema.parse(head);
    await checkedGitCommand(this.commands, workspace.path, [
      "git",
      "check-ref-format",
      `refs/heads/${workspace.branch}`,
    ]);
    const resolved = await checkedGitCommand(this.commands, workspace.path, [
      "git",
      "rev-parse",
      "--verify",
      `${head}^{commit}`,
    ]);
    const branchHead = await checkedGitCommand(this.commands, workspace.path, [
      "git",
      "rev-parse",
      "--verify",
      `refs/heads/${workspace.branch}`,
    ]);
    if (resolved !== head || branchHead !== head)
      throw new Error("Submit requires the exact branch commit OID");
    const fetch = await checkedGitCommand(this.commands, workspace.path, [
      "git",
      "remote",
      "get-url",
      "--all",
      "origin",
    ]);
    const remote = await checkedGitCommand(this.commands, workspace.path, [
      "git",
      "remote",
      "get-url",
      "--push",
      "--all",
      "origin",
    ]);
    if (fetch.split(/\r?\n/).length !== 1 || remote.split(/\r?\n/).length !== 1)
      throw new Error("Submission requires one fetch and push destination");
    const repository = normalizeClaimHome(remote).identity;
    if (
      normalizeClaimHome(fetch).identity !== repository ||
      !/^github\.com\/[\w.-]+\/[\w.-]+$/.test(repository)
    )
      throw new Error("GitHub fetch and push repository must match");
    await verifyRemoteDestination(this.commands, workspace.path, remote);
    return { ...workspace, head, remote, repository };
  }

  async push(target: ArtifactTarget): Promise<void> {
    commitOidSchema.parse(target.head);
    await verifyRemoteDestination(this.commands, target.path, target.remote);
    const result = await this.commands.run(
      ["git", "push", "--porcelain", target.remote, `${target.head}:refs/heads/${target.branch}`],
      target.path,
    );
    if (result.exitCode !== 0) throw new Error(`git push exited ${result.exitCode}`);
    const tip = await checkedGitCommand(this.commands, target.path, [
      "git",
      "ls-remote",
      target.remote,
      `refs/heads/${target.branch}`,
    ]);
    if (tip !== `${target.head}\trefs/heads/${target.branch}`)
      throw new Error("Pushed branch head was not verified");
  }

  async pullRequests(target: ArtifactTarget, key?: string): Promise<PullRequest[]> {
    const byBranch = await this.list(target, ["--head", target.branch]);
    const byKey = key
      ? (await this.list(target, ["--search", `"${key}" in:title`])).filter((item) =>
          ticketKeyMatches(item.title, key),
        )
      : [];
    return [
      ...new Map(
        [...byBranch, ...byKey].map((item) => [item.url, this.parse(item, target)]),
      ).values(),
    ];
  }

  async open(target: ArtifactTarget, request: ArtifactRequest): Promise<PullRequest> {
    const result = await this.commands.run(
      [
        "gh",
        "pr",
        "create",
        "--repo",
        target.repository,
        "--head",
        target.branch,
        "--title",
        request.title,
        "--body",
        request.body,
        ...(request.draft ? ["--draft"] : []),
      ],
      target.path,
    );
    if (result.exitCode !== 0) throw new Error(`gh pr create exited ${result.exitCode}`);
    const url = z.url().parse(result.stdout.trim().split(/\r?\n/).at(-1)?.trim());
    this.requireUrl(url, target);
    const view = await this.commands.run(
      ["gh", "pr", "view", url, "--repo", target.repository, "--json", fields],
      target.path,
    );
    if (view.exitCode !== 0) throw new Error("Created PR readback failed");
    return this.parse(pullRequestSchema.parse(JSON.parse(view.stdout)), target);
  }

  private async list(target: ArtifactTarget, filter: readonly string[]) {
    const result = await this.commands.run(
      [
        "gh",
        "pr",
        "list",
        "--repo",
        target.repository,
        "--state",
        "all",
        ...filter,
        "--json",
        fields,
        "--limit",
        "1000",
      ],
      target.path,
    );
    if (result.exitCode !== 0) throw new Error(`gh pr list exited ${result.exitCode}`);
    const items = z.array(pullRequestSchema).parse(JSON.parse(result.stdout));
    if (items.length === 1000)
      throw new Error("PR listing may be truncated; cannot verify uniqueness");
    return items;
  }

  private requireUrl(url: string, target: ArtifactTarget) {
    const parsed = new URL(url);
    const repositoryPath = target.repository.slice("github.com/".length);
    if (
      parsed.protocol !== "https:" ||
      parsed.host !== "github.com" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !/^\d+$/.test(parsed.pathname.split("/").at(-1) ?? "") ||
      parsed.pathname.slice(0, parsed.pathname.lastIndexOf("/")).toLowerCase() !==
        `/${repositoryPath}/pull`.toLowerCase()
    )
      throw new Error("PR URL does not belong to the verified push repository");
  }

  private parse(item: z.infer<typeof pullRequestSchema>, target: ArtifactTarget): PullRequest {
    this.requireUrl(item.url, target);
    return { url: item.url, branch: item.headRefName, title: item.title, state: item.state };
  }
}
