import type { GitCommandExecutor } from "../adapters/workspaces/git.ts";
import { projectClaimHome } from "../configuration/files.ts";
import { type ClaimHome, normalizeClaimHome } from "../domain/claim-home.ts";

export const CHANGE_CLAIM_HOME =
  "Set claim_home in interlock.toml on the work repo's default branch, or run: interlock config edit --set claim-home VALUE";

export interface ResolvedClaimHome {
  home: ClaimHome;
  source: string;
  configCommit: string;
}

export async function resolveClaimHome(
  repository: string,
  git: GitCommandExecutor,
  userSetting: string | undefined,
): Promise<ResolvedClaimHome> {
  const checked = async (argv: readonly string[], failure: string) => {
    const result = await git.run(argv, repository);
    if (result.exitCode !== 0) throw new Error(`${failure}: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const head = await checked(
    ["git", "ls-remote", "--symref", "origin", "HEAD"],
    "Claim home: cannot read the work repo's default branch",
  );
  const branch = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(head)?.[1];
  const configCommit = /^([0-9a-f]{40,64})\tHEAD$/m.exec(head)?.[1];
  if (!branch || !configCommit)
    throw new Error("Claim home: the work repo's origin reports no default branch");
  await checked(
    ["git", "fetch", "--no-tags", "origin", branch],
    `Claim home: cannot fetch ${branch}`,
  );
  const listing = await checked(
    ["git", "ls-tree", "--name-only", configCommit, "--", "interlock.toml"],
    `Claim home: cannot read ${branch} at ${configCommit}`,
  );
  if (listing.trim()) {
    const content = await checked(
      ["git", "cat-file", "blob", `${configCommit}:interlock.toml`],
      `Claim home: cannot read interlock.toml on ${branch} at ${configCommit}`,
    );
    const project = projectClaimHome(content);
    if (project !== undefined)
      return {
        home: normalizeClaimHome(project),
        source: `claim_home in interlock.toml on ${branch} at ${configCommit}`,
        configCommit,
      };
  }
  if (userSetting !== undefined)
    return {
      home: normalizeClaimHome(userSetting),
      source: "user setting claim-home",
      configCommit,
    };
  const origin = await checked(
    ["git", "remote", "get-url", "origin"],
    "Claim home: cannot read the work repo's origin",
  );
  return { home: normalizeClaimHome(origin), source: "work repo origin", configCommit };
}
