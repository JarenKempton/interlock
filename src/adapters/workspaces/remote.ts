import { normalizeClaimHome } from "../../domain/claim-home.ts";
import type { GitCommandExecutor } from "./git.ts";

export async function checkedGitCommand(
  git: GitCommandExecutor,
  cwd: string,
  argv: readonly string[],
): Promise<string> {
  const result = await git.run(argv, cwd);
  if (result.exitCode !== 0) throw new Error("Git submission verification failed");
  return result.stdout.trim();
}

export async function verifyRemoteDestination(
  git: GitCommandExecutor,
  cwd: string,
  url: string,
): Promise<void> {
  const remote = normalizeClaimHome(url);
  const expanded = await checkedGitCommand(git, cwd, ["git", "ls-remote", "--get-url", url]);
  if (normalizeClaimHome(expanded).identity !== remote.identity)
    throw new Error("Submission remote is rewritten to another repository");
  const rewrites = await git.run(
    ["git", "config", "--null", "--get-regexp", "^url\\..*\\.pushinsteadof$"],
    cwd,
  );
  if (rewrites.exitCode === 1) return;
  if (rewrites.exitCode !== 0) throw new Error("Submission push rewrites cannot be verified");
  for (const entry of rewrites.stdout.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\n");
    if (separator < 0) throw new Error("Submission push rewrites cannot be verified");
    const prefix = entry.slice(separator + 1);
    if (url.startsWith(prefix) || expanded.startsWith(prefix))
      throw new Error("Submission push destination is rewritten");
  }
}
