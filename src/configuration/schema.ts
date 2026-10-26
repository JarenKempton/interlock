/** Portable configuration validation and resolution; no filesystem or runtime discovery. */
import { z } from "zod";

export const configText = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 &&
      ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
// Preserve the public string-valued settings API while checking supported modes at runtime.
const runtimeMode = configText.refine((value) =>
  ["approval-required", "auto-accept-edits", "auto", "full-access"].includes(value),
);
const interactionMode = configText.refine((value) => ["default", "plan"].includes(value));
export const personalSettingsSchema = z
  .strictObject({
    host: configText,
    agent: configText,
    model: configText,
    effort: configText,
    context_window: configText,
    runtime_mode: runtimeMode,
    interaction_mode: interactionMode,
  })
  .partial();
export const SETTING_KEYS = personalSettingsSchema.keyof().options;
export type PersonalSettings = z.infer<typeof personalSettingsSchema>;

const repositorySchema = z.strictObject({
  github: configText.regex(/^[\w.-]+\/[\w.-]+$/),
  path: configText,
  worktree_root: configText,
  base_branch: configText,
});
const mapSchema = z.strictObject({
  repository: configText,
  claim_status: configText,
  available_statuses: z.array(configText).min(1),
});
const jiraSite = configText.refine((site) => {
  try {
    const url = new URL(site);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
});
const roleModelSchema = z.strictObject({
  provider: configText,
  model: configText,
  options: z.record(configText, z.union([configText, z.boolean()])).optional(),
});
export const projectConfigurationSchema = z
  .strictObject({
    version: z.literal(1),
    repositories: z.record(configText, repositorySchema),
    maps: z.record(configText, mapSchema),
    tracker: z.strictObject({
      jira: z.strictObject({ site: jiraSite }),
    }),
    t3: z
      .strictObject({
        provider: configText.optional(),
        model: configText.optional(),
        thinking_effort: configText.optional(),
        context_window: configText.optional(),
        runtime_mode: runtimeMode.optional(),
        interaction_mode: interactionMode.optional(),
        open: z.enum(["none", "browser"]).optional(),
      })
      .default({}),
    defaults: personalSettingsSchema.default({}),
    required: personalSettingsSchema.default({}),
    roles: z
      .strictObject({
        implementer: roleModelSchema.optional(),
        reviewers: z.record(configText, roleModelSchema).optional(),
      })
      .optional(),
    instructions: z
      .strictObject({
        runtime_contract: configText.optional(),
        role_templates: z
          .strictObject({
            task: configText.optional(),
            research: configText.optional(),
            prototype: configText.optional(),
            decision: configText.optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .superRefine((project, ctx) => {
    for (const [key, map] of Object.entries(project.maps)) {
      if (!Object.hasOwn(project.repositories, map.repository))
        ctx.addIssue({
          code: "custom",
          path: ["maps", key, "repository"],
          message: "Unknown repository",
        });
    }
  });
export type ProjectConfiguration = z.infer<typeof projectConfigurationSchema>;
const resolvedConfigurationSchema = z.strictObject({
  version: z.literal(1),
  source: z.strictObject({ path: configText, version: configText }),
  project: projectConfigurationSchema,
  settings: personalSettingsSchema,
  sources: z.partialRecord(
    personalSettingsSchema.keyof(),
    z.enum(["default", "personal", "required"]),
  ),
});
export type ResolvedConfiguration = z.infer<typeof resolvedConfigurationSchema>;

// Only schema-owned field names may reach diagnostics; record keys and values are untrusted.
function diagnosticPath(schema: z.core.$ZodType, path: readonly PropertyKey[]): string {
  const parts: string[] = [];
  for (const key of path) {
    while (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)
      schema = schema.unwrap();
    if (
      schema instanceof z.ZodObject &&
      typeof key === "string" &&
      Object.hasOwn(schema.shape, key)
    ) {
      parts.push(key);
      schema = schema.shape[key];
    } else if (schema instanceof z.ZodRecord) {
      parts.push("<key>");
      schema = schema.valueType;
    } else if (schema instanceof z.ZodArray) {
      parts.push("item");
      schema = schema.element;
    } else break;
  }
  return parts.join(".");
}
function parseConfiguration<S extends z.ZodType>(
  schema: S,
  value: unknown,
  label: string,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const path = diagnosticPath(schema, result.error.issues[0]?.path ?? []);
    throw new Error(`Invalid configuration at ${label}${path ? `.${path}` : ""}`);
  }
  return result.data;
}
export function validatePersonalSettings(value: unknown): PersonalSettings {
  return parseConfiguration(personalSettingsSchema, value, "settings");
}
export function validateProjectConfiguration(value: unknown): ProjectConfiguration {
  return parseConfiguration(projectConfigurationSchema, value, "project");
}
function t3DefaultsV1(project: ProjectConfiguration): PersonalSettings {
  const defaults: PersonalSettings = { host: "t3" };
  const entries = [
    ["agent", project.t3.provider],
    ["model", project.t3.model],
    ["effort", project.t3.thinking_effort],
    ["context_window", project.t3.context_window],
    ["runtime_mode", project.t3.runtime_mode],
    ["interaction_mode", project.t3.interaction_mode],
  ] as const;
  for (const [setting, value] of entries) {
    if (value !== undefined) defaults[setting] = value;
  }
  return defaults;
}
export function resolveProjectConfiguration(
  project: ProjectConfiguration,
  personal: PersonalSettings,
  source: ResolvedConfiguration["source"],
): ResolvedConfiguration {
  return resolveConfigurationV1(project, personal, source);
}

// Version 1 is a persisted format, including its resolution semantics. Future
// behavior changes must introduce a new version and retain this decoder for old
// receipts; validation must never dispatch through the latest-execution resolver.
function resolveConfigurationV1(
  project: ProjectConfiguration,
  personal: PersonalSettings,
  source: ResolvedConfiguration["source"],
): ResolvedConfiguration {
  project = validateProjectConfiguration(project);
  personal = validatePersonalSettings(personal);
  const settings = { ...t3DefaultsV1(project), ...project.defaults };
  const sources: ResolvedConfiguration["sources"] = {};
  for (const key of SETTING_KEYS) {
    if (settings[key] !== undefined) sources[key] = "default";
    if (personal[key] !== undefined) {
      settings[key] = personal[key];
      sources[key] = "personal";
    }
    const required = project.required[key];
    if (required !== undefined) {
      if (personal[key] !== undefined && personal[key] !== required)
        throw new Error(
          `Personal ${key} conflicts with project requirement in ${source.path}; use --follow KEY to remove one choice or --follow all to clear all personal choices`,
        );
      settings[key] = required;
      sources[key] = "required";
    }
  }
  return structuredClone({ version: 1, source, project, settings, sources });
}
/** Validate persisted snapshots without re-reading today's defaults. */
export function validateResolvedConfiguration(value: unknown): ResolvedConfiguration {
  const item = parseConfiguration(resolvedConfigurationSchema, value, "resolved");
  const personal: PersonalSettings = {};
  for (const key of SETTING_KEYS) {
    if (item.sources[key] === "personal" && item.settings[key] !== undefined)
      personal[key] = item.settings[key];
  }
  const resolved = resolveConfigurationV1(item.project, personal, item.source);
  for (const key of SETTING_KEYS)
    if (
      resolved.settings[key] !== item.settings[key] ||
      resolved.sources[key] !== item.sources[key]
    )
      throw new Error("Invalid configuration at resolved.settings");
  return resolved;
}
