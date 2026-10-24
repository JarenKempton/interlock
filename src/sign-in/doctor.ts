import { CLAIM_LOCK_NAMESPACE } from "../adapters/claims/git-lock.ts";
import { BunGitCommandExecutor } from "../adapters/workspaces/git.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { lookupCredentials, savedSite, trackerSignIns } from "./credentials.ts";

export async function doctorChecks(services: RuntimeServices, project: string | undefined) {
  const jira = await jiraSignIn(services, project);
  const claimLock = await pushAccess(services);
  return {
    jira: jira.report,
    claimLock: { repository: claimLock.repository, dryRunPush: claimLock.missing === undefined },
    missing: [...jira.missing, ...(claimLock.missing ? [claimLock.missing] : [])],
  };
}

async function jiraSignIn(services: RuntimeServices, project: string | undefined) {
  const { label, adapter } = trackerSignIns(services).jira;
  const site = savedSite(services, "jira");
  const signedOut = (missing: string) => ({
    report: { site: site ?? null, signedIn: false },
    missing: [missing],
  });
  if (!site) return signedOut(`${label} sign-in: run interlock login jira`);
  try {
    const found = await lookupCredentials(services, "jira", adapter, site);
    if (!found.credentials)
      return signedOut(
        `${label} credentials for ${site}: run interlock login jira or set ${found.missing.join(" and ")}`,
      );
    const account = (await adapter.verify(site, found.credentials)).name;
    const signedIn = { site, signedIn: true, account, from: found.sources };
    try {
      const missing = await adapter.missingPermissions(site, found.credentials, project);
      return {
        report: { ...signedIn, permissions: { project: project ?? "any", missing } },
        missing,
      };
    } catch (error) {
      return {
        report: signedIn,
        missing: [`${label} permission check at ${site}: ${message(error)}`],
      };
    }
  } catch (error) {
    return signedOut(`${label} sign-in at ${site}: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pushAccess(services: RuntimeServices) {
  const git = services.execution?.git ?? new BunGitCommandExecutor();
  const cwd = services.configuration?.cwd ?? process.cwd();
  const top = await git.run(["git", "rev-parse", "--show-toplevel"], cwd);
  if (top.exitCode !== 0)
    return {
      repository: null,
      missing: "Git claim lock: the current directory is not a Git repository",
    };
  const repository = top.stdout.trim();
  if ((await git.run(["git", "remote", "get-url", "origin"], repository)).exitCode !== 0)
    return { repository, missing: `Git claim lock: ${repository} has no origin remote` };
  const probe = await git.run(
    ["git", "push", "--dry-run", "--porcelain", "origin", `HEAD:${CLAIM_LOCK_NAMESPACE}/doctor`],
    repository,
  );
  return {
    repository,
    missing:
      probe.exitCode === 0
        ? undefined
        : `Git claim lock: origin refuses a dry-run push from ${repository}`,
  };
}
