import { expect, test } from "bun:test";
import { GitHubArtifactHost } from "../src/adapters/artifacts/github.ts";
import type { CommandResult, GitCommandExecutor } from "../src/adapters/workspaces/git.ts";
import type { ArtifactTarget } from "../src/execution/lane.ts";
import { checkedGit, gitRemoteFixture } from "./fixtures/git-remote.ts";

const head = "a".repeat(40);
const branch = "feature/JWB-878";
const remote = "https://github.com/o/r.git";
const target: ArtifactTarget = {
  path: "/work",
  branch,
  head,
  remote,
  repository: "github.com/o/r",
};
const pr = {
  url: "https://github.com/o/r/pull/7",
  headRefName: branch,
  title: "JWB-878: title",
  state: "OPEN",
};

class Commands implements GitCommandExecutor {
  calls: (readonly string[])[] = [];
  fetch = remote;
  push = remote;
  rewrites: string | undefined;
  listed = [pr];
  view = pr;
  branchHead = head;
  constructor(private readonly override?: (argv: readonly string[]) => CommandResult | undefined) {}
  async run(argv: readonly string[]): Promise<CommandResult> {
    this.calls.push(argv);
    const override = this.override?.(argv);
    if (override) return override;
    let stdout = "";
    if (argv[1] === "config")
      return this.rewrites === undefined
        ? { exitCode: 1, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: this.rewrites, stderr: "" };
    if (argv[1] === "remote") stdout = argv.includes("--push") ? this.push : this.fetch;
    if (argv[1] === "rev-parse") stdout = argv.at(-1)?.startsWith("refs/") ? this.branchHead : head;
    if (argv[1] === "ls-remote")
      stdout = argv.includes("--get-url") ? (argv.at(-1) ?? "") : `${head}\trefs/heads/${branch}`;
    if (argv[0] === "gh") {
      if (argv[2] === "list") stdout = JSON.stringify(this.listed);
      if (argv[2] === "create") stdout = `${pr.url}\n`;
      if (argv[2] === "view") stdout = JSON.stringify(this.view);
    }
    return { exitCode: 0, stdout, stderr: "" };
  }
}

test("prepare binds GitHub operations to the verified push repository and immutable branch head", async () => {
  const commands = new Commands();
  const host = new GitHubArtifactHost(commands);
  expect(await host.prepare({ path: target.path, branch }, head)).toEqual(target);
  await host.push(target);
  await host.pullRequests(target, "JWB-878");
  expect(await host.open(target, { title: pr.title, body: "evidence", draft: true })).toEqual({
    url: pr.url,
    branch,
    title: pr.title,
    state: "OPEN",
  });
  for (const argv of commands.calls.filter((argv) => argv[0] === "gh"))
    expect(argv[argv.indexOf("--repo") + 1]).toBe("github.com/o/r");
  expect(commands.calls).toContainEqual([
    "git",
    "push",
    "--porcelain",
    remote,
    `${head}:refs/heads/${branch}`,
  ]);
  expect(
    commands.calls.filter((argv) => argv[2] === "list").every((argv) => argv.includes("all")),
  ).toBe(true);
});

test("force/refspec injection and non-OID inputs are rejected before spawning", async () => {
  for (const invalid of [`+${head}`, "HEAD", `${head}:refs/heads/main`, "--all", "abcd"]) {
    const commands = new Commands();
    const host = new GitHubArtifactHost(commands);
    await expect(host.prepare({ path: "/work", branch }, invalid)).rejects.toThrow();
    await expect(host.push({ ...target, head: invalid })).rejects.toThrow();
    expect(commands.calls).toEqual([]);
  }
});

test("mismatched/multiple push URLs, push rewrites and stale branch heads are refused", async () => {
  for (const patch of [
    { push: "https://github.com/other/repo.git" },
    { push: `${remote}\nhttps://github.com/other/repo.git` },
    { rewrites: "url.https://other.test/.pushinsteadof\nhttps://github.com/\0" },
    { branchHead: "b".repeat(40) },
  ]) {
    const commands = new Commands();
    Object.assign(commands, patch);
    await expect(
      new GitHubArtifactHost(commands).prepare({ path: "/work", branch }, head),
    ).rejects.toThrow();
    expect(commands.calls.some((argv) => argv[1] === "push" || argv[0] === "gh")).toBe(false);
  }
});

test("PR results from another repository and a full truncated list are rejected", async () => {
  const commands = new Commands();
  commands.listed = [{ ...pr, url: "https://github.com/cli/cli/pull/7" }];
  const host = new GitHubArtifactHost(commands);
  await expect(host.pullRequests(target)).rejects.toThrow("verified push repository");
  commands.listed = Array.from({ length: 1000 }, () => pr);
  await expect(host.pullRequests(target)).rejects.toThrow("truncated");
  commands.view = { ...pr, url: "https://github.com/cli/cli/pull/7" };
  await expect(host.open(target, { title: pr.title, body: "b", draft: true })).rejects.toThrow(
    "verified push repository",
  );
});

test("title search excludes a longer ticket key, and keeps closed matching PRs", async () => {
  const commands = new Commands((argv) =>
    argv[2] === "list" && argv.includes("--head")
      ? { exitCode: 0, stdout: "[]", stderr: "" }
      : undefined,
  );
  commands.listed = [
    { ...pr, title: "JWB-8780: other" },
    { ...pr, title: "X_JWB-878: other" },
    { ...pr, url: "https://github.com/o/r/pull/8", title: "JWB-878: closed", state: "CLOSED" },
  ];
  expect(await new GitHubArtifactHost(commands).pullRequests(target, "JWB-878")).toEqual([
    { url: "https://github.com/o/r/pull/8", branch, title: "JWB-878: closed", state: "CLOSED" },
  ]);
});

test("push failure and mismatched push readback do not claim success", async () => {
  for (const fail of ["push", "ls-remote"]) {
    const commands = new Commands((argv) =>
      argv[1] === fail && !argv.includes("--get-url")
        ? { exitCode: fail === "push" ? 1 : 0, stdout: "", stderr: "" }
        : undefined,
    );
    await expect(new GitHubArtifactHost(commands).push(target)).rejects.toThrow();
  }
});

test("real temporary Git remote cannot be rewound with a plus-prefixed head", async () => {
  const fixture = await gitRemoteFixture();
  const git = (args: string[]) => checkedGit(fixture.git, args, fixture.alice);
  try {
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@invalid",
      "commit",
      "--allow-empty",
      "-m",
      "one",
    ]);
    const old = await git(["rev-parse", "HEAD"]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@invalid",
      "commit",
      "--allow-empty",
      "-m",
      "two",
    ]);
    const current = await git(["rev-parse", "HEAD"]);
    const local = { ...target, path: fixture.alice, remote: fixture.remote, head: current };
    const host = new GitHubArtifactHost(fixture.git);
    await host.push(local);
    await expect(host.push({ ...local, head: old })).rejects.toThrow();
    await expect(host.push({ ...local, head: `+${old}` })).rejects.toThrow();
    expect(await git(["ls-remote", fixture.remote, `refs/heads/${branch}`])).toBe(
      `${current}\trefs/heads/${branch}`,
    );
  } finally {
    await fixture.dispose();
  }
});

test("merge proof names the repository exactly as prepare and the submission record do, whatever the URL's case", async () => {
  const url = "https://github.com/JarenKempton/Interlock/pull/70";
  const commands = new Commands((argv) =>
    argv[0] === "gh" && argv[1] === "api"
      ? {
          exitCode: 0,
          stdout: JSON.stringify({
            html_url: url,
            merged: true,
            merge_commit_sha: "b".repeat(40),
            head: { ref: branch, sha: head, repo: { full_name: "JarenKempton/Interlock" } },
            base: { ref: "main", repo: { full_name: "JarenKempton/Interlock" } },
          }),
          stderr: "",
        }
      : undefined,
  );
  commands.fetch = commands.push = "https://github.com/JarenKempton/Interlock.git";
  const host = new GitHubArtifactHost(commands);
  const prepared = await host.prepare({ path: target.path, branch }, head);
  expect(prepared.repository).toBe("github.com/jarenkempton/interlock");
  expect((await host.merged(url)).repository).toBe(prepared.repository);
});
