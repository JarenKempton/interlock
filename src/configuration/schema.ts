/** Portable configuration validation and resolution; no filesystem or runtime discovery. */
import { z } from "zod";

export const configText = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 &&
      !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
// Preserve the public string-valued settings API while checking supported modes at runtime.
const runtimeMode = configText.refine((value) =>
  ["approval-required", "auto-accept-edits", "auto", "full-access"].includes(value),
);
const interactionMode = configText.refine((value) => ["default", "plan"].includes(value));
const personalChoices = {
  host: configText,
  harness: configText,
  model: configText,
  effort: configText,
  context_window: configText,
  runtime_mode: runtimeMode,
  interaction_mode: interactionMode,
};
export const personalSettingsSchema = z.strictObject(personalChoices).partial();
export const SETTING_KEYS = personalSettingsSchema.keyof().options;
export type PersonalSettings = z.infer<typeof personalSettingsSchema>;

const jiraSite = configText.refine((site) => {
  try {
    const url = new URL(site);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      /^[^.]+(\.[^.]+)+$/.test(url.hostname)
    );
  } catch {
    return false;
  }
});
const githubRepo = configText.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/);
const branchTemplate = configText.refine((value) => value.includes("{key}"));
const statusList = configText.refine((value) => statuses(value).length > 0);
const lensName = configText.regex(/^[a-z][a-z0-9-]*$/);
const lensList = configText.refine(
  (value) =>
    statuses(value).length > 0 &&
    statuses(value).every((lens) => lensName.safeParse(lens).success) &&
    new Set(statuses(value)).size === statuses(value).length,
);
const reviewChoices = {
  reviewer_harness: configText,
  reviewer_model: configText,
  reviewer_effort: configText,
};
export const REVIEWER_CHOICE_KEYS = z.object(reviewChoices).keyof().options;
export interface ReviewChoices {
  lenses: string[];
  harness?: string;
  model?: string;
  effort?: string;
}
export function reviewChoicesFrom(user: UserSettings): ReviewChoices {
  const settings = validateUserSettings(user);
  return {
    lenses: settings.reviewers ? statuses(settings.reviewers) : [],
    ...(settings.reviewer_harness ? { harness: settings.reviewer_harness } : {}),
    ...(settings.reviewer_model ? { model: settings.reviewer_model } : {}),
    ...(settings.reviewer_effort ? { effort: settings.reviewer_effort } : {}),
  };
}
export const userSettingsSchema = z
  .strictObject({
    jira_site: jiraSite,
    github_repo: githubRepo,
    claim_home: configText,
    ...personalChoices,
    reviewers: lensList,
    ...reviewChoices,
    branch: branchTemplate,
    pickable_statuses: statusList,
    claimed_status: configText,
    t3_cli: configText,
  })
  .partial();
export type UserSettings = z.infer<typeof userSettingsSchema>;
export type UserSettingKey = keyof UserSettings;
export const CHOICE_KEYS = [
  ...SETTING_KEYS,
  "reviewers",
  "reviewer_harness",
  "reviewer_model",
  "reviewer_effort",
  "branch",
  "pickable_statuses",
  "claimed_status",
  "t3_cli",
] as const satisfies readonly UserSettingKey[];

function statuses(value: string): string[] {
  return value
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean);
}

const instructionsSchema = z.strictObject({
  runtime_contract: configText.optional(),
  role_templates: z
    .strictObject({
      task: configText.optional(),
      research: configText.optional(),
      prototype: configText.optional(),
      decision: configText.optional(),
    })
    .optional(),
});
const trackerSchema = z.strictObject({ jira: z.strictObject({ site: jiraSite }) });

const PERSONAL_REPLACEMENT =
  "host, harness, model, effort, context_window, runtime_mode and interaction_mode are user settings; run interlock config edit --set KEY VALUE";
export const REMOVED_SECTIONS: Readonly<Record<string, string>> = {
  repositories:
    "pickup uses the current Git repo or --repo PATH; the worktree root and base branch come from the repo and its origin's default branch",
  maps: "pickup reads blockers from the tracker; set pickable and claimed statuses under [statuses] or with interlock config edit --set pickable_statuses VALUE",
  t3: PERSONAL_REPLACEMENT,
  defaults: PERSONAL_REPLACEMENT,
  required: PERSONAL_REPLACEMENT,
  roles: PERSONAL_REPLACEMENT,
};
export const projectConfigurationSchema = z.strictObject({
  version: z.literal(2).optional(),
  claim_home: configText.optional(),
  tracker: trackerSchema.optional(),
  statuses: z
    .strictObject({
      pickable: z.array(configText).min(1).optional(),
      claimed: configText.optional(),
    })
    .optional(),
  instructions: instructionsSchema.optional(),
});
export type ProjectConfiguration = z.infer<typeof projectConfigurationSchema>;

const resolvedSettingsSchema = z.strictObject({
  ...personalSettingsSchema.shape,
  host: configText,
  branch: branchTemplate,
  pickable_statuses: z.array(configText).min(1),
  claimed_status: configText,
  jira_site: jiraSite.optional(),
  github_repo: githubRepo.optional(),
});
export type ResolvedSettings = z.infer<typeof resolvedSettingsSchema>;
type SettingsLayer = { [K in keyof ResolvedSettings]?: ResolvedSettings[K] | undefined };
const RESOLVED_KEYS = resolvedSettingsSchema.keyof().options;
const sourceSchema = z.strictObject({ path: configText, version: configText });
export const repositorySpecSchema = z.strictObject({
  name: configText,
  remote: configText,
  path: configText,
  worktreeRoot: configText,
  baseBranch: configText,
});
export const resolvedConfigurationSchema = z.strictObject({
  version: z.literal(2),
  source: sourceSchema.optional(),
  project: projectConfigurationSchema.optional(),
  settings: resolvedSettingsSchema,
  sources: z.partialRecord(z.enum(RESOLVED_KEYS), z.enum(["default", "user", "shared"])),
  repository: repositorySpecSchema.optional(),
});
export type ResolvedConfiguration = z.infer<typeof resolvedConfigurationSchema>;
type ResolvedSource = "default" | "user" | "shared";

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
export function validateUserSettings(value: unknown): UserSettings {
  return parseConfiguration(userSettingsSchema, value, "user");
}
export function validateProjectConfiguration(value: unknown): ProjectConfiguration {
  const removed = new Map<string, string[]>();
  for (const [section, replacement] of Object.entries(REMOVED_SECTIONS))
    if (value && typeof value === "object" && Object.hasOwn(value, section))
      removed.set(replacement, [...(removed.get(replacement) ?? []), `[${section}]`]);
  if (removed.size)
    throw new Error(
      `interlock.toml ${[...removed]
        .map(
          ([replacement, sections]) =>
            `${sections.join(", ")} ${sections.length > 1 ? "were" : "was"} removed: ${replacement}`,
        )
        .join("; ")}. Delete these sections from interlock.toml first.`,
    );
  return parseConfiguration(projectConfigurationSchema, value, "project");
}

const DEFAULT_SETTINGS_V2 = {
  host: "t3",
  branch: "task/{key}",
  pickable_statuses: ["To Do"],
  claimed_status: "In Progress",
} satisfies SettingsLayer;

function userChoices(user: UserSettings): SettingsLayer {
  const {
    claim_home: _claimHome,
    pickable_statuses,
    reviewers: _reviewers,
    reviewer_harness: _harness,
    reviewer_model: _model,
    reviewer_effort: _effort,
    ...choices
  } = validateUserSettings(user);
  return {
    ...choices,
    ...(pickable_statuses === undefined ? {} : { pickable_statuses: statuses(pickable_statuses) }),
  };
}

export function resolveConfiguration(
  project: ProjectConfiguration | undefined,
  user: UserSettings,
  source?: ResolvedConfiguration["source"],
): ResolvedConfiguration {
  return resolveConfigurationV2(project, userChoices(user), source);
}

// Shared tracker facts outrank user settings; personal choices exist only in user settings.
function resolveConfigurationV2(
  project: ProjectConfiguration | undefined,
  user: SettingsLayer,
  source: ResolvedConfiguration["source"],
): ResolvedConfiguration {
  if (project) project = validateProjectConfiguration(project);
  const shared: SettingsLayer = {
    ...(project?.tracker ? { jira_site: project.tracker.jira.site } : {}),
    ...(project?.statuses?.pickable ? { pickable_statuses: project.statuses.pickable } : {}),
    ...(project?.statuses?.claimed ? { claimed_status: project.statuses.claimed } : {}),
  };
  const layers: [ResolvedSource, SettingsLayer][] = [
    ["default", DEFAULT_SETTINGS_V2],
    ["user", user],
    ["shared", shared],
  ];
  const settings: Record<string, unknown> = {};
  const sources: ResolvedConfiguration["sources"] = {};
  for (const [layer, values] of layers)
    for (const key of RESOLVED_KEYS) {
      const value = values[key];
      if (value === undefined) continue;
      settings[key] = value;
      sources[key] = layer;
    }
  return structuredClone({
    version: 2,
    ...(source ? { source } : {}),
    ...(project ? { project } : {}),
    settings: parseConfiguration(resolvedSettingsSchema, settings, "resolved.settings"),
    sources,
  });
}

/** Validate the current resolution without re-reading today's user settings. */
export function validateResolvedConfiguration(value: unknown): ResolvedConfiguration {
  const item = parseConfiguration(resolvedConfigurationSchema, value, "resolved");
  const user: SettingsLayer = {};
  for (const key of RESOLVED_KEYS)
    if (item.sources[key] === "user") Object.assign(user, { [key]: item.settings[key] });
  const resolved = resolveConfigurationV2(item.project, user, item.source);
  const same = (a: object, b: object, key: string) =>
    JSON.stringify(Reflect.get(a, key)) === JSON.stringify(Reflect.get(b, key));
  for (const key of RESOLVED_KEYS)
    if (!same(resolved.settings, item.settings, key) || !same(resolved.sources, item.sources, key))
      throw new Error("Invalid configuration at resolved.settings");
  return structuredClone({
    ...resolved,
    ...(item.repository ? { repository: item.repository } : {}),
  });
}
