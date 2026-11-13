import { existsSync } from "node:fs";
import { z } from "zod";
import { CLAIM_LOCK_NAMESPACE } from "../adapters/git/claim-lock.ts";
import { BunGitCommandExecutor } from "../adapters/git/workspace.ts";
import { projectConfigPath } from "../configuration/files.ts";
import type { RuntimeServices } from "../app/runtime-services.ts";
import { lookupCredentials, savedSite, type TrackerAccount } from "./credentials.ts";
import { configuredTracker, TRACKERS, trackerAccount } from "../app/tracker/registry.ts";

const trackerReportSchema = z.union([
  z.strictObject({
    label: z.string(),
    site: z.string().nullable(),
    signedIn: z.literal(true),
    account: z.string(),
    from: z.array(z.enum(["environment", "credential store", "external cli"])),
    permissions: z
      .strictObject({ project: z.string(), summary: z.string(), missing: z.array(z.string()) })
      .optional(),
    missing: z.array(z.string()),
  }),
  z.strictObject({
    label: z.string(),
    site: z.string().nullable(),
    signedIn: z.boolean(),
    missing: z.array(z.string()),
  }),
]);
type TrackerReport = z.infer<typeof trackerReportSchema>;

export const doctorReportSchema = z.strictObject({
  ok: z.boolean(),
  version: z.string(),
  database: z.string(),
  config: z.strictObject({ path: z.string(), found: z.boolean() }),
  trackers: z.record(z.string(), trackerReportSchema),
  claimLock: z.strictObject({ repository: z.string().nullable(), dryRunPush: z.boolean() }),
  missing: z.array(z.string()),
});
export type DoctorReport = z.infer<typeof doctorReportSchema>;

export async function doctorChecks(services: RuntimeServices, project: string | undefined) {
  const sites = Object.fromEntries(
    TRACKERS.map((entry) => [entry.setting, savedSite(services, trackerAccount(entry, services))]),
  );
  const { entry } = configuredTracker(sites);
  const trackers: Record<string, TrackerReport> = {
    [entry.name]: await trackerSignIn(services, trackerAccount(entry, services), project),
  };
  const claimLock = await pushAccess(services);
  return {
    trackers,
    claimLock: { repository: claimLock.repository, dryRunPush: claimLock.missing === undefined },
    missing: [
      ...Object.values(trackers).flatMap((report) => report.missing),
      ...(claimLock.missing ? [claimLock.missing] : []),
    ],
  };
}

async function trackerSignIn(
  services: RuntimeServices,
  account: TrackerAccount,
  project: string | undefined,
): Promise<TrackerReport> {
  const { label, name, signIn } = account;
  if (signIn.kind === "none") return { label, site: null, signedIn: true, missing: [] };
  if (signIn.kind === "external_cli") {
    try {
      const who = await signIn.verify();
      return {
        label,
        site: null,
        signedIn: true,
        account: who.name,
        from: ["external cli"],
        missing: [],
      };
    } catch (error) {
      return {
        label,
        site: null,
        signedIn: false,
        missing: [`${label} sign-in through ${signIn.command}: ${message(error)}`],
      };
    }
  }
  const site = savedSite(services, account);
  const signedOut = (missing: string): TrackerReport => ({
    label,
    site: site ?? null,
    signedIn: false,
    missing: [missing],
  });
  if (!site) return signedOut(`${label} sign-in: run interlock login ${name}`);
  try {
    const found = await lookupCredentials(services, name, signIn, site);
    if (!found.credentials)
      return signedOut(
        `${label} credentials for ${site}: run interlock login ${name} or set ${found.missing.join(" and ")}`,
      );
    const signedIn = {
      label,
      site,
      signedIn: true as const,
      account: (await signIn.verify(site, found.credentials)).name,
      from: found.sources,
    };
    if (!signIn.permissions) return { ...signedIn, missing: [] };
    try {
      const missing = await signIn.permissions.missing(site, found.credentials, project);
      return {
        ...signedIn,
        permissions: { project: project ?? "any", summary: signIn.permissions.summary, missing },
        missing,
      };
    } catch (error) {
      return {
        ...signedIn,
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
  const { claimLock } = report;
  const lockFix = claimLock.dryRunPush ? [] : report.missing.slice(-1);
  return [
    ...Object.entries(report.trackers).flatMap(([name, tracker]) => renderTracker(name, tracker)),
    ...(claimLock.dryRunPush
      ? check(true, `Claim lock dry-run push to origin from ${claimLock.repository}`)
      : check(false, "Claim lock dry-run push failed", lockFix)),
    ...check(true, `Database ${report.database}`),
    ...check(true, `Config ${report.config.path}${report.config.found ? "" : " (not found)"}`),
  ];
}

function renderTracker(name: string, tracker: TrackerReport): string[] {
  const { label, missing } = tracker;
  if (tracker.signedIn && !("account" in tracker)) return check(true, `${label} needs no sign-in`);
  if (!("account" in tracker))
    return [
      ...check(
        false,
        `${label} not signed in${tracker.site ? ` at ${tracker.site}` : ""}`,
        missing,
      ),
      ...check(false, `${label} permissions not checked`, [
        `sign in first: run interlock login ${name}`,
      ]),
    ];
  const at = tracker.site ? ` at ${tracker.site}` : "";
  const signIn = check(
    true,
    `${label} signed in${at} as ${tracker.account} (${tracker.from.join(", ")})`,
  );
  const checked = tracker.permissions;
  if (!checked)
    return [
      ...signIn,
      ...(missing.length ? check(false, `${label} permissions incomplete`, missing) : []),
    ];
  const scope = ` in ${checked.project}`;
  return [
    ...signIn,
    ...(missing.length === 0
      ? check(true, `${label} permissions${scope}: ${checked.summary}`)
      : check(false, `${label} permissions${scope} incomplete`, missing)),
  ];
}

function check(ok: boolean, line: string, fixes: readonly string[] = []): string[] {
  return [`${ok ? "✓" : "✗"} ${line}`, ...fixes.map((fix) => `  → ${fix}`)];
}
