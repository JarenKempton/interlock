import { existsSync } from "node:fs";
import { z } from "zod";
import { CLAIM_LOCK_NAMESPACE } from "../adapters/claims/git-lock.ts";
import { BunGitCommandExecutor } from "../adapters/workspaces/git.ts";
import { projectConfigPath } from "../configuration/files.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { lookupCredentials, savedSite, trackerSignIns } from "./credentials.ts";

export const doctorReportSchema = z.strictObject({
  ok: z.boolean(),
  version: z.string(),
  database: z.string(),
  config: z.strictObject({ path: z.string(), found: z.boolean() }),
  jira: z.union([
    z.strictObject({
      site: z.string(),
      signedIn: z.boolean(),
      account: z.string(),
      from: z.array(z.enum(["environment", "credential store"])),
      permissions: z.strictObject({ project: z.string(), missing: z.array(z.string()) }).optional(),
    }),
    z.strictObject({ site: z.string().nullable(), signedIn: z.boolean() }),
  ]),
  claimLock: z.strictObject({ repository: z.string().nullable(), dryRunPush: z.boolean() }),
  missing: z.array(z.string()),
});
export type DoctorReport = z.infer<typeof doctorReportSchema>;

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

export function doctorConfig(services: RuntimeServices) {
  const path = projectConfigPath(services.configuration?.cwd ?? process.cwd());
  return { path, found: existsSync(path) };
}

export function renderDoctor(report: DoctorReport) {
  const { jira, claimLock } = report;
  const lockFix = claimLock.dryRunPush ? [] : report.missing.slice(-1);
  const jiraFixes = claimLock.dryRunPush ? report.missing : report.missing.slice(0, -1);
  const checked = "permissions" in jira ? jira.permissions : undefined;
  const scope = checked ? ` in ${checked.project}` : "";
  const signIn =
    "account" in jira
      ? check(true, `Jira signed in at ${jira.site} as ${jira.account} (${jira.from.join(", ")})`)
      : check(false, `Jira not signed in${jira.site ? ` at ${jira.site}` : ""}`, jiraFixes);
  const permissions = !("account" in jira)
    ? check(false, "Jira permissions not checked", ["sign in first: run interlock login jira"])
    : checked?.missing.length === 0
      ? check(true, `Jira permissions${scope}: browse, transition, assign, edit issue properties`)
      : check(false, `Jira permissions${scope} incomplete`, jiraFixes);
  return [
    ...signIn,
    ...permissions,
    ...(claimLock.dryRunPush
      ? check(true, `Claim lock dry-run push to origin from ${claimLock.repository}`)
      : check(false, "Claim lock dry-run push failed", lockFix)),
    ...check(true, `Database ${report.database}`),
    ...check(true, `Config ${report.config.path}${report.config.found ? "" : " (not found)"}`),
  ];
}

function check(ok: boolean, line: string, fixes: readonly string[] = []): string[] {
  return [`${ok ? "✓" : "✗"} ${line}`, ...fixes.map((fix) => `  → ${fix}`)];
}
