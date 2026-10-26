import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitCommandExecutor } from "../src/adapters/workspaces/git.ts";
import { normalizeClaimHome } from "../src/domain/claim-home.ts";
import { resolveClaimHome } from "../src/execution/claim-home.ts";
import {
  checkedGit,
  GIT_TEST_TIMEOUT_MS,
  type GitRemoteFixture,
  gitRemoteFixture,
} from "./fixtures/git-remote.ts";
import { commitFixture } from "./fixtures/pickup-runtime.ts";

let fixtures: GitRemoteFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.dispose()));
  fixtures = [];
});

test.each([
  [
    "JarenKempton/Interlock",
    "github.com/jarenkempton/interlock",
    "https://github.com/JarenKempton/Interlock.git",
  ],
  ["https://github.com/JarenKempton/interlock.git", "github.com/jarenkempton/interlock", undefined],
  ["git@github.com:JarenKempton/interlock.git", "github.com/jarenkempton/interlock", undefined],
  ["ssh://git@GitLab.example:22/Team/Repo.git", "gitlab.example/Team/Repo", undefined],
  ["https://git.example:8443/team/repo", "git.example:8443/team/repo", undefined],
  ["file:///srv/locks.git", "/srv/locks", "/srv/locks.git"],
  ["/srv/locks.git/", "/srv/locks", "/srv/locks.git"],
  ["C:\\locks\\home.git", "C:\\locks\\home", undefined],
])("normalizes %s", (input, identity, url) => {
  expect(normalizeClaimHome(input)).toEqual({ identity, url: url ?? input });
});

test.each([
  "",
  "owner",
  "https://token@github.com/owner/repo.git",
  "https://user:secret@github.com/owner/repo.git",
  "http://github.com/owner/repo.git",
  "owner/repo extra",
])("rejects %p", (input) => {
  expect(() => normalizeClaimHome(input)).toThrow("Claim home");
});

async function workRepo(project?: string) {
  const fixture = await gitRemoteFixture();
  fixtures.push(fixture);
  if (project !== undefined) {
    await writeFile(join(fixture.alice, "interlock.toml"), project);
    await checkedGit(fixture.git, ["add", "interlock.toml"], fixture.alice);
  }
  await commitFixture(fixture.git, fixture.alice, "work");
  await checkedGit(fixture.git, ["branch", "-M", "main"], fixture.alice);
  await checkedGit(fixture.git, ["remote", "add", "origin", fixture.remote], fixture.alice);
  await checkedGit(fixture.git, ["push", "--quiet", "origin", "main"], fixture.alice);
  await checkedGit(fixture.git, ["symbolic-ref", "HEAD", "refs/heads/main"], fixture.remote);
  const commit = await checkedGit(fixture.git, ["rev-parse", "HEAD"], fixture.alice);
  return {
    fixture,
    commit,
    resolve: (user?: string, git: GitCommandExecutor = fixture.git) =>
      resolveClaimHome(fixture.alice, git, user),
  };
}

test(
  "the default branch's claim_home wins over the user setting and origin, recording its commit",
  async () => {
    const { commit, resolve } = await workRepo('claim_home = "team/locks"\n');
    expect(await resolve("someone/else")).toEqual({
      home: normalizeClaimHome("team/locks"),
      source: `claim_home in interlock.toml on refs/heads/main at ${commit}`,
      configCommit: commit,
    });
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each([
  ["a missing file", undefined],
  ["a missing key", "version = 1\n"],
])(
  "%s moves on to the user setting, then origin",
  async (_, project) => {
    const { fixture, commit, resolve } = await workRepo(project);
    expect(await resolve("team/locks")).toEqual({
      home: normalizeClaimHome("team/locks"),
      source: "user setting claim-home",
      configCommit: commit,
    });
    expect(await resolve()).toEqual({
      home: normalizeClaimHome(fixture.remote),
      source: "work repo origin",
      configCommit: commit,
    });
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each([
  ["malformed TOML", "claim_home = ", "Malformed project TOML"],
  ["a non-string claim_home", "claim_home = 3\n", "Project claim_home must be"],
  ["an invalid claim_home", 'claim_home = "https://t@x.example/a/b"\n', "without credentials"],
])(
  "%s on the default branch stops resolution",
  async (_, project, message) => {
    const { resolve } = await workRepo(project);
    await expect(resolve("team/locks")).rejects.toThrow(message);
  },
  GIT_TEST_TIMEOUT_MS,
);

test.each(["ls-remote", "fetch", "ls-tree", "cat-file"])(
  "a failed %s stops resolution instead of moving on",
  async (command) => {
    const { fixture, resolve } = await workRepo('claim_home = "team/locks"\n');
    const failing: GitCommandExecutor = {
      run: (argv, cwd) =>
        argv[1] === command
          ? Promise.resolve({ exitCode: 128, stdout: "", stderr: "unreachable" })
          : fixture.git.run(argv, cwd),
    };
    await expect(resolve("team/other", failing)).rejects.toThrow("Claim home: cannot");
  },
  GIT_TEST_TIMEOUT_MS,
);
