import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { type ProjectConfiguration, validateProjectConfiguration } from "./schema.ts";
export function configurationVersion(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
export function projectConfigPath(cwd: string, path = "interlock.toml"): string {
  const requested = resolve(cwd, path);
  try {
    return realpathSync(requested);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    // Initialization has no file yet; canonicalize its existing parent instead.
    return resolve(realpathSync(dirname(requested)), basename(requested));
  }
}
/** Resolve local config references only. */
export function configurationReference(configPath: string, path: string): string {
  if (path.startsWith("~"))
    throw new Error("Use a project-relative or absolute path; shell expansion is not performed");
  return isAbsolute(path) ? path : resolve(dirname(configPath), path);
}
export function parseProjectToml(content: string): ProjectConfiguration {
  let value: unknown;
  try {
    value = Bun.TOML.parse(content);
  } catch {
    throw new Error("Malformed project TOML; values omitted from diagnostic");
  }
  return validateProjectConfiguration(value);
}
/** Read-only instruction loading. Content identities belong in the eventual execution receipt. */
export function loadConfigurationInstructions(
  configuration: import("./schema.ts").ResolvedConfiguration,
  role: import("../domain/model.ts").TicketKind,
) {
  const references = configuration.project.instructions;
  const load = (path: string) => {
    const resolved = configurationReference(configuration.source.path, path);
    const content = readFileSync(resolved, "utf8");
    return { path, resolvedPath: resolved, version: configurationVersion(content), content };
  };
  return {
    ...(references?.runtime_contract ? { runtimeContract: load(references.runtime_contract) } : {}),
    ...(references?.role_templates?.[role]
      ? { roleTemplate: load(references.role_templates[role]) }
      : {}),
  };
}
export function projectClaimHome(content: string): string | undefined {
  let value: unknown;
  try {
    value = Bun.TOML.parse(content);
  } catch {
    throw new Error("Malformed project TOML; values omitted from diagnostic");
  }
  const parsed = z.looseObject({ claim_home: z.string().optional() }).safeParse(value);
  if (!parsed.success) throw new Error("Project claim_home must be a Git remote URL or owner/repo");
  return parsed.data.claim_home;
}
